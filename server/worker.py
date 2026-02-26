import asyncio
import os
import uuid
import threading
from fastembed import TextEmbedding
from langchain_core.embeddings import Embeddings
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_groq import ChatGroq
from langchain_qdrant import QdrantVectorStore
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue

# Read from env so local dev and cloud both work without code changes
QDRANT_URL  = os.getenv("QDRANT_URL",  "http://localhost:6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", None)
COLLECTION  = "pdf-rag"
EMBED_MODEL = "BAAI/bge-small-en-v1.5"  # 67 MB — cached at build time on Render
CHAT_MODEL  = "llama-3.3-70b-versatile"  # Groq free tier — very fast
VECTOR_SIZE = 384                         # bge-small output dimension
UPLOAD_DIR  = os.path.join(os.path.dirname(__file__), "uploads")

# ── FastEmbed singleton ───────────────────────────────────────────────────────
_fastembed_model: TextEmbedding | None = None
_fastembed_lock = threading.Lock()


def _get_fastembed_model() -> TextEmbedding:
    global _fastembed_model
    with _fastembed_lock:
        if _fastembed_model is None:
            print(f"[worker] Loading FastEmbed model '{EMBED_MODEL}'…")
            _fastembed_model = TextEmbedding(EMBED_MODEL)
            print("[worker] FastEmbed model ready.")
    return _fastembed_model


def _batch_embed(texts: list[str]) -> list[list[float]]:
    """Embed texts via FastEmbed (model cached on disk from build time)."""
    model = _get_fastembed_model()
    return [v.tolist() for v in model.embed(texts)]


class _FastEmbeddings(Embeddings):
    """Thin LangChain Embeddings wrapper around _batch_embed."""
    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return _batch_embed(texts)
    def embed_query(self, text: str) -> list[float]:
        return _batch_embed([text])[0]

# ── Singletons — created once, reused on every request ──────────────────────
_qdrant_client: QdrantClient | None = None
_vector_store: QdrantVectorStore | None = None
_llm: ChatGroq | None = None

# ── Embedding status tracking (#11) ─────────────────────────────────────────
_embedding_status: dict[str, str] = {}   # basename -> 'processing' | 'done' | 'error'
_embedding_lock = threading.Lock()
_embedded_pdfs: list[str] = []    # basenames of successfully embedded PDFs


def get_embedding_status(filename: str) -> str:
    """Return current embedding status for a filename."""
    return _embedding_status.get(filename, 'unknown')


def get_qdrant_client() -> QdrantClient:
    global _qdrant_client
    if _qdrant_client is None:
        _qdrant_client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY or None)
        print(f"[worker] Qdrant connected → {QDRANT_URL}")
    return _qdrant_client


def ensure_collection(client: QdrantClient):
    existing = {c.name: c for c in client.get_collections().collections}
    if COLLECTION in existing:
        # Check if vector size matches — recreate if it changed (e.g. model switch)
        info = client.get_collection(COLLECTION)
        current_size = info.config.params.vectors.size
        if current_size != VECTOR_SIZE:
            print(f"[worker] Collection vector size mismatch ({current_size} vs {VECTOR_SIZE}) — recreating.")
            client.delete_collection(COLLECTION)
            client.create_collection(
                collection_name=COLLECTION,
                vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
            )
            print(f"[worker] Collection '{COLLECTION}' recreated with size={VECTOR_SIZE}.")
    else:
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
        )
        print(f"[worker] Collection '{COLLECTION}' created with size={VECTOR_SIZE}.")


def reset_collection(client: QdrantClient):
    """Drop and recreate the collection, wiping all previously embedded PDFs."""
    existing = [c.name for c in client.get_collections().collections]
    if COLLECTION in existing:
        client.delete_collection(COLLECTION)
        print(f"[worker] Collection '{COLLECTION}' deleted.")
    client.create_collection(
        collection_name=COLLECTION,
        vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
    )
    print(f"[worker] Collection '{COLLECTION}' recreated.")


def get_vector_store() -> QdrantVectorStore:
    global _vector_store
    if _vector_store is None:
        client = get_qdrant_client()
        ensure_collection(client)
        _vector_store = QdrantVectorStore(
            client=client,
            collection_name=COLLECTION,
            embedding=_FastEmbeddings(),
        )
        print("[worker] Vector store initialised.")
    return _vector_store


def get_llm() -> ChatGroq:
    global _llm
    if _llm is None:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY is not set. Add it to server/.env")
        _llm = ChatGroq(
            model=CHAT_MODEL,
            api_key=api_key,
            temperature=0.3,
        )
        print(f"[worker] LLM initialised ({CHAT_MODEL}).")
    return _llm


# ── PDF ingestion ────────────────────────────────────────────────────────────

def process_pdf(file_path: str):
    """Load, chunk and embed a PDF file into Qdrant. Called as a background task."""
    filename = os.path.basename(file_path)
    with _embedding_lock:
        _embedding_status[filename] = 'processing'
    print(f"[worker] Processing: {file_path}")

    try:
        # Ensure collection exists (multi-PDF mode — no reset)
        client = get_qdrant_client()
        ensure_collection(client)

        # ── 1. Load ──────────────────────────────────────────────────────────
        loader = PyPDFLoader(file_path)
        docs = loader.load()

        # ── 2. Split — larger chunks + less overlap → fewer embedding calls ──
        splitter = RecursiveCharacterTextSplitter(chunk_size=2000, chunk_overlap=100)
        chunks = splitter.split_documents(docs)
        print(f"[worker] Split into {len(chunks)} chunks")

        # ── 3. Batch-embed via Ollama native API (all texts in one HTTP call) ─
        texts = [c.page_content for c in chunks]
        vectors = _batch_embed(texts)
        print(f"[worker] Embedded {len(vectors)} chunks via batch API")

        # ── 4. Batch-upsert to Qdrant in ONE request ─────────────────────────
        points = [
            PointStruct(
                id=str(uuid.uuid4()),
                vector=vec,
                payload={
                    "page_content": chunks[i].page_content,
                    "metadata": chunks[i].metadata,
                    "filename": filename,   # enables per-PDF filtered retrieval
                },
            )
            for i, vec in enumerate(vectors)
        ]
        client.upsert(collection_name=COLLECTION, points=points, wait=True)
        print(f"[worker] Done — {len(points)} points upserted to Qdrant.")

        # Invalidate cached vector store so next query uses fresh data
        global _vector_store
        _vector_store = None

        with _embedding_lock:
            _embedding_status[filename] = 'done'
        if filename not in _embedded_pdfs:
            _embedded_pdfs.append(filename)

    except Exception as exc:
        with _embedding_lock:
            _embedding_status[filename] = 'error'
        print(f"[worker] Embedding error: {exc}")
        raise


# ── Chat helpers ─────────────────────────────────────────────────────────────

def _retrieve_per_pdf(
    query_text: str,
    active_pdfs: list[str],
    k_per_pdf: int = 4,
) -> list:
    """
    For each filename in active_pdfs, run a Qdrant similarity search filtered
    to only that file's chunks.  This guarantees every uploaded PDF contributes
    to the context regardless of relative similarity scores.
    Falls back to a global (unfiltered) search if a filtered search returns
    nothing (e.g. older points that pre-date the 'filename' payload field).
    """
    client = get_qdrant_client()
    # Embed the query once and reuse for every per-PDF search
    query_vector = _batch_embed([query_text])[0]

    all_docs = []
    seen_ids: set[str] = set()

    for fname in active_pdfs:
        resp = client.query_points(
            collection_name=COLLECTION,
            query=query_vector,
            query_filter=Filter(
                must=[
                    FieldCondition(key="filename", match=MatchValue(value=fname))
                ]
            ),
            limit=k_per_pdf,
            with_payload=True,
        )
        hits = resp.points
        if not hits:
            # Fallback: no filtered hits — file may have been embedded before
            # the 'filename' field was added; include global top results instead
            resp = client.query_points(
                collection_name=COLLECTION,
                query=query_vector,
                limit=k_per_pdf,
                with_payload=True,
            )
            hits = resp.points
        for h in hits:
            if h.id not in seen_ids:
                seen_ids.add(h.id)
                all_docs.append(h)

    return all_docs


def _build_messages(context: str, query: str, history: list[dict] | None = None, num_pdfs: int = 1) -> list:
    """Build the message list sent to the LLM, including conversation history (#9)."""
    if num_pdfs == 0 or not context.strip():
        system_content = (
            "You are a helpful AI assistant. "
            "No PDF has been uploaded yet. "
            "Answer the user's question as helpfully as possible using your general knowledge, "
            "and let them know they can upload a PDF for document-specific answers."
        )
    else:
        pdf_phrase = f"{num_pdfs} PDF{'s' if num_pdfs > 1 else ''}" if num_pdfs > 1 else "the provided PDF"
        system_content = (
            f"You are a helpful AI assistant. The user has uploaded {pdf_phrase}. "
            "Answer the user's question based only on the provided context excerpts, "
            "which may come from multiple documents. When relevant, mention which document "
            "the information comes from. If the answer is not in the context, say "
            "'I couldn't find that information in the provided PDF(s).'"
        )
    messages = [{"role": "system", "content": system_content}]
    # Inject last 6 messages (3 exchanges) as conversation memory
    if history:
        for turn in history[-6:]:
            role = turn.get("role")
            content = turn.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})
    messages.append({
        "role": "user",
        "content": f"Context:\n{context}\n\nQuestion: {query}" if context.strip() else query,
    })
    return messages


async def chat_with_pdf(query: str) -> dict:
    store = get_vector_store()
    relevant_docs = await store.as_retriever(search_kwargs={"k": 4}).ainvoke(query)
    context = "\n\n".join(doc.page_content for doc in relevant_docs)
    response = await get_llm().ainvoke(_build_messages(context, query))
    return {
        "message": response.content,
        "docs": [{"content": d.page_content, "metadata": d.metadata} for d in relevant_docs],
    }


async def stream_chat_with_pdf(
    query: str,
    history: list[dict] | None = None,
    active_pdfs: list[str] | None = None,
):
    """Yields typed event dicts: {type: 'token', data: str} and {type: 'sources', data: list}."""

    QDRANT_TIMEOUT = 12  # seconds — fail fast on Render free tier instead of hanging

    if active_pdfs:
        # Per-PDF filtered retrieval — guarantees every file contributes chunks
        try:
            raw_hits = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(
                    None, _retrieve_per_pdf, query, active_pdfs
                ),
                timeout=QDRANT_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raw_hits = []
            print("[worker] Qdrant query timed out — answering without PDF context.")

        # Build context and source list from raw Qdrant ScoredPoint objects
        context_parts = []
        sources = []
        for h in raw_hits:
            payload = h.payload or {}
            text = payload.get("page_content", "")
            meta = payload.get("metadata", {})
            fname = payload.get("filename", os.path.basename(meta.get("source", "unknown.pdf")))
            context_parts.append(f"[{fname}]\n{text}")
            sources.append({
                "page": meta.get("page", "?"),
                "source": fname,
                "snippet": text[:200] + ("…" if len(text) > 200 else ""),
            })
        context = "\n\n".join(context_parts)
        num_pdfs = len(active_pdfs)
    elif _embedded_pdfs:
        # PDFs exist in Qdrant but none is explicitly active — global fallback
        try:
            store = get_vector_store()
            relevant_docs = await asyncio.wait_for(
                store.as_retriever(search_kwargs={"k": 6}).ainvoke(query),
                timeout=QDRANT_TIMEOUT,
            )
        except asyncio.TimeoutError:
            relevant_docs = []
            print("[worker] Qdrant global query timed out — answering without PDF context.")
        context = "\n\n".join(doc.page_content for doc in relevant_docs)
        sources = [
            {
                "page": d.metadata.get("page", "?"),
                "source": os.path.basename(d.metadata.get("source", "unknown.pdf")),
                "snippet": d.page_content[:200] + ("…" if len(d.page_content) > 200 else ""),
            }
            for d in relevant_docs
        ]
        num_pdfs = 1
    else:
        # No PDFs uploaded at all — answer directly without touching Qdrant
        context = ""
        sources = []
        num_pdfs = 0

    async for chunk in get_llm().astream(_build_messages(context, query, history, num_pdfs)):
        if chunk.content:
            yield {"type": "token", "data": chunk.content}
    yield {"type": "sources", "data": sources}


async def get_suggestions(query: str, answer: str) -> list[str]:
    """Generate 3 short follow-up question suggestions based on the Q&A exchange."""
    import json as _json
    llm = get_llm()
    messages = [
        {
            "role": "system",
            "content": (
                "Based on the user's question and the assistant's answer, generate exactly 3 short "
                "follow-up questions the user might want to ask next. "
                "Return ONLY a valid JSON array of 3 strings, no extra text. "
                'Example: ["What else?", "Can you elaborate?", "How does X work?"]'
            ),
        },
        {
            "role": "user",
            "content": f"Question: {query}\n\nAnswer: {answer}",
        },
    ]
    try:
        response = await llm.ainvoke(messages)
        suggestions = _json.loads(response.content)
        if isinstance(suggestions, list):
            return [str(s) for s in suggestions[:3]]
    except Exception:
        pass
    return []


# ── Multi-PDF management ─────────────────────────────────────────────────────

def list_embedded_pdfs() -> list[str]:
    """Return basenames of all successfully embedded PDFs."""
    return list(_embedded_pdfs)


def delete_pdf_from_collection(filename: str) -> None:
    """Remove all Qdrant vectors for the given PDF and delete the file from disk."""
    global _embedded_pdfs
    client = get_qdrant_client()
    existing = [c.name for c in client.get_collections().collections]
    if COLLECTION not in existing:
        return

    # Scroll to collect point IDs whose metadata.source basename matches
    ids_to_delete: list = []
    offset = None
    while True:
        result, next_offset = client.scroll(
            collection_name=COLLECTION,
            limit=1000,
            offset=offset,
            with_payload=["metadata"],
            with_vectors=False,
        )
        for point in result:
            src = point.payload.get("metadata", {}).get("source", "")
            if os.path.basename(src) == filename or src == filename:
                ids_to_delete.append(point.id)
        if next_offset is None:
            break
        offset = next_offset

    if ids_to_delete:
        from qdrant_client.models import PointIdsList
        client.delete(
            collection_name=COLLECTION,
            points_selector=PointIdsList(points=ids_to_delete),
        )

    with _embedding_lock:
        _embedding_status.pop(filename, None)
    _embedded_pdfs = [f for f in _embedded_pdfs if f != filename]

    fpath = os.path.join(UPLOAD_DIR, filename)
    if os.path.exists(fpath):
        os.remove(fpath)
    print(f"[worker] Deleted PDF: {filename} ({len(ids_to_delete)} chunks removed)")


def merge_pdfs(filenames: list[str], output_name: str) -> str:
    """Merge multiple PDFs by page order and return the output file path."""
    from pypdf import PdfReader, PdfWriter
    if not output_name.endswith(".pdf"):
        output_name += ".pdf"
    output_path = os.path.join(UPLOAD_DIR, output_name)
    writer = PdfWriter()
    for fname in filenames:
        fpath = os.path.join(UPLOAD_DIR, fname)
        if not os.path.exists(fpath):
            raise FileNotFoundError(f"File not found: {fname}")
        reader = PdfReader(fpath)
        for page in reader.pages:
            writer.add_page(page)
    with open(output_path, "wb") as f:
        writer.write(f)
    print(f"[worker] Merged {len(filenames)} PDFs \u2192 {output_name}")
    return output_path


async def translate_pdf_stream(filename: str, target_language: str):
    """Extract text from a PDF and stream its translation to target_language."""
    fpath = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(fpath):
        yield {"type": "token", "data": f"Error: file \u2018{filename}\u2019 not found."}
        return

    loader = PyPDFLoader(fpath)
    docs = loader.load()
    full_text = "\n\n".join(doc.page_content for doc in docs)

    MAX_CHARS = 6000
    truncated = len(full_text) > MAX_CHARS
    if truncated:
        # Cut at the last whitespace before the limit to avoid mid-word splits
        cut = full_text.rfind(' ', 0, MAX_CHARS)
        full_text = full_text[:cut if cut > 0 else MAX_CHARS]

    yield {"type": "token", "data": f"## {target_language} Translation\n*Source: {filename}*\n\n"}

    messages = [
        {
            "role": "system",
            "content": (
                f"You are a professional translator. "
                f"Translate the following document text into {target_language}. "
                "Output ONLY the translated text — no introductions, no explanations, "
                "no preamble, no meta-commentary. "
                "Preserve the original structure, headings, and paragraphs exactly."
            ),
        },
        {"role": "user", "content": full_text},
    ]
    async for chunk in get_llm().astream(messages):
        if chunk.content:
            yield {"type": "token", "data": chunk.content}

    if truncated:
        yield {
            "type": "token",
            "data": "\n\n*\u2014 Document was truncated to 6\u202f000 characters for translation. \u2014*",
        }
