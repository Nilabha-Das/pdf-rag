/**
 * Central API base URL.
 *
 * Priority order:
 *  1. NEXT_PUBLIC_API_BASE env var (set in Vercel / .env.local)
 *  2. localhost when running locally
 *  3. Hardcoded Render URL as final fallback
 */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:8000'
    : 'https://pdf-rag-iwnh.onrender.com');
