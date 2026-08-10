import type { NextConfig } from 'next'

// output: 'standalone' — the portability kit (MASTER-PLAN §10, §13). A standalone
// build runs identically under `node server.js` on Vercel or the Windows Server;
// nothing here may branch on the host.
const nextConfig: NextConfig = {
  output: 'standalone',
  // pdfjs-dist is loaded at runtime by lib/pdf.ts (server-only, Node runtime) to
  // read a PDF's page count. It ships its own ESM/worker plumbing that webpack
  // mangles when bundled; leaving it external makes `require`/`import` resolve
  // from node_modules at runtime instead.
  serverExternalPackages: ['pdfjs-dist'],
  eslint: {
    // next build already fails on ESLint errors by default — this just makes it explicit.
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
}

export default nextConfig
