import type { NextConfig } from "next";

// In production (Vercel) all /backend/* requests are proxied to Render.
// In local dev the proxy still works but you can also set NEXT_PUBLIC_API_BASE
// in .env.local to hit the backend directly.
const RENDER_URL =
  process.env.RENDER_BACKEND_URL ?? 'https://pdf-rag-iwnh.onrender.com';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/backend/:path*',
        destination: `${RENDER_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
