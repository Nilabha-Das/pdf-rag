import os
import shutil
import json
import time

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, File, UploadFile, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from pydantic import BaseModel

from worker import (
    process_pdf, stream_chat_with_pdf, get_suggestions,
    get_embedding_status, list_embedded_pdfs, delete_pdf_from_collection,
    merge_pdfs, translate_pdf_stream, UPLOAD_DIR,
)

WORKER_UPLOAD_DIR = UPLOAD_DIR
from database import init_db, get_sessions, upsert_session, delete_session

# ──────────────────────────────────────────────
# App setup
# ──────────────────────────────────────────────
app = FastAPI(title="PDF RAG API")

# Initialise SQLite chat-history database
init_db()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten this in production
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────

@app.get("/")
def health_check():
    return {"status": "All Good!"}


@app.post("/upload/pdf")
async def upload_pdf(background_tasks: BackgroundTasks, pdf: UploadFile = File(...)):
    """
    Accept a PDF file, save it to disk and kick off embedding in the background.
    The endpoint returns immediately; embedding happens asynchronously.
    """
    if not pdf.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    file_path = os.path.join(UPLOAD_DIR, pdf.filename)
    with open(file_path, "wb") as f:
        shutil.copyfileobj(pdf.file, f)

    # Process (chunk + embed) the PDF in the background
    background_tasks.add_task(process_pdf, file_path)

    return {"message": "File uploaded. Embedding is in progress.", "filename": pdf.filename}


@app.get("/pdfs")
def get_pdfs():
    """List all successfully embedded PDFs."""
    return {"pdfs": list_embedded_pdfs()}


@app.delete("/pdfs/{filename}")
def remove_pdf(filename: str):
    """Remove a PDF's vectors from Qdrant and delete the file from disk."""
    delete_pdf_from_collection(filename)
    return {"status": "ok"}


@app.get("/pdf/download/{filename}")
def download_pdf(filename: str):
    """Serve a PDF file from the uploads directory."""
    file_path = os.path.join(WORKER_UPLOAD_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(file_path, media_type="application/pdf", filename=filename)


class MergeRequest(BaseModel):
    filenames: list    # list of server-side filenames to merge
    output_name: str   # desired name for the merged file


@app.post("/pdf/merge")
async def merge_pdfs_route(req: MergeRequest, background_tasks: BackgroundTasks):
    """Merge two or more PDFs and embed the result."""
    if len(req.filenames) < 2:
        raise HTTPException(status_code=400, detail="At least 2 filenames required.")
    try:
        output_path = merge_pdfs(req.filenames, req.output_name)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    filename = os.path.basename(output_path)
    background_tasks.add_task(process_pdf, output_path)
    return {"message": "Merge complete. Embedding in progress.", "filename": filename}


class TranslateRequest(BaseModel):
    filename: str
    language: str


@app.post("/pdf/translate/stream")
async def translate_pdf(req: TranslateRequest):
    """Stream a translation of a PDF to the requested language."""
    if not req.filename.strip() or not req.language.strip():
        raise HTTPException(status_code=400, detail="filename and language are required.")

    async def event_generator():
        async for event in translate_pdf_stream(req.filename, req.language):
            yield f"data: {json.dumps(event)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/upload/status")
def upload_status(filename: str):
    """Poll the embedding status for a previously uploaded PDF."""
    if not filename.strip():
        raise HTTPException(status_code=400, detail="filename is required.")
    status = get_embedding_status(filename)
    return {"filename": filename, "status": status}


class ChatRequest(BaseModel):
    message: str
    history: list = []        # list of {role, content} dicts for conversation memory
    active_pdfs: list = []   # list of server-side filenames currently active in the UI


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """
    Streaming version — returns tokens as Server-Sent Events.
    Accepts POST body with message + optional conversation history + active_pdfs.
    """
    if not req.message or not req.message.strip():
        raise HTTPException(status_code=400, detail="message is required.")

    async def event_generator():
        try:
            async for event in stream_chat_with_pdf(
                req.message, req.history, req.active_pdfs or None
            ):
                # event is already {"type": "token"|"sources", "data": ...}
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as exc:
            # Surface the error as an SSE event so the frontend can display it
            yield f"data: {json.dumps({'type': 'error', 'data': str(exc)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/suggestions")
async def suggestions(message: str, answer: str):
    """
    Given the last user message and assistant answer, return 3 follow-up question suggestions.
    """
    if not message.strip() or not answer.strip():
        raise HTTPException(status_code=400, detail="message and answer params are required.")

    result = await get_suggestions(message, answer)
    return {"suggestions": result}


# ──────────────────────────────────────────────
# Chat-history routes  (per-user, stored in SQLite)
# ──────────────────────────────────────────────

class SessionPayload(BaseModel):
    user_id:    str
    session_id: str
    title:      str
    messages:   list
    created_at: int


@app.get("/history")
def get_history(user_id: str):
    """Return all saved chat sessions for a Clerk user."""
    if not user_id.strip():
        raise HTTPException(status_code=400, detail="user_id is required.")
    return {"sessions": get_sessions(user_id)}


@app.post("/history/session")
def save_session(payload: SessionPayload):
    """Create or update a chat session (upsert by session_id)."""
    if not payload.user_id.strip():
        raise HTTPException(status_code=400, detail="user_id is required.")
    upsert_session(
        user_id    = payload.user_id,
        session_id = payload.session_id,
        title      = payload.title,
        messages   = payload.messages,
        created_at = payload.created_at,
        updated_at = int(time.time() * 1000),
    )
    return {"status": "ok"}


@app.delete("/history/session/{session_id}")
def delete_session_route(session_id: str, user_id: str):
    """Permanently delete one chat session (only if it belongs to user_id)."""
    if not user_id.strip():
        raise HTTPException(status_code=400, detail="user_id is required.")
    delete_session(user_id=user_id, session_id=session_id)
    return {"status": "ok"}
