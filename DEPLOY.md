# Deployment Guide

## Architecture
| Part | Deployed To | Cost |
|------|------------|------|
| Frontend (Next.js) | Vercel | Free |
| Backend (FastAPI) | Render | Free |
| Vector DB (Qdrant) | Qdrant Cloud | Free (1 GB) |

---

## Step 1 — Push to GitHub

1. Create a new GitHub repo (e.g. `pdf-rag`)
2. In your terminal:
```bash
cd PDF_Rag
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/pdf-rag.git
git push -u origin main
```

---

## Step 2 — Qdrant Cloud (Vector DB)

1. Go to **https://cloud.qdrant.io** → Sign up (free)
2. Create a new **Free Tier cluster** (pick any region)
3. Once created, copy:
   - **Cluster URL** → looks like `https://abc123.us-east4-0.gcp.cloud.qdrant.io`
   - **API Key** → from the cluster's API Keys tab

---

## Step 3 — Deploy Backend to Render

1. Go to **https://render.com** → Sign up → **New → Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Root Directory**: `server`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Plan**: Free
4. Under **Environment Variables**, add:
   | Key | Value |
   |-----|-------|
   | `GROQ_API_KEY` | `gsk_wOetuSh6xPLRozFbx2T...` (your key) |
   | `QDRANT_URL` | `https://abc123...qdrant.io` (from Step 2) |
   | `QDRANT_API_KEY` | your Qdrant Cloud API key |
   | `PYTHONUNBUFFERED` | `1` |
5. Click **Deploy** — first deploy takes ~5 mins (installs fastembed + downloads the embedding model)
6. Copy your backend URL: `https://pdf-rag-backend.onrender.com`

---

## Step 4 — Deploy Frontend to Vercel

1. Go to **https://vercel.com** → Sign up → **Add New Project**
2. Import your GitHub repo
3. Settings:
   - **Root Directory**: `client`
   - **Framework**: Next.js (auto-detected)
4. Under **Environment Variables**, add:
   | Key | Value |
   |-----|-------|
   | `NEXT_PUBLIC_API_BASE` | `https://pdf-rag-backend.onrender.com` |
5. Click **Deploy**
6. Vercel gives you a URL like `https://pdf-rag-xyz.vercel.app` — **share this with your reviewer!**

---

## Notes

- **First wake-up**: Render free tier sleeps after 15 min of inactivity. First request takes ~30s to wake up.
- **First embed**: The FastEmbed model (~274 MB) downloads on first PDF upload after each Render restart.
- **Uploaded PDFs**: Stored on Render's ephemeral disk — lost on restart. For demo purposes this is fine.
- **Chat history**: Stored in SQLite on Render — also resets on restart. Sessions are saved in the browser's localStorage too.
