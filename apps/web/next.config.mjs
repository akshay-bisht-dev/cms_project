import { fileURLToPath } from 'node:url';

const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // End-to-end tests build into their own directory so they never overwrite the dev build.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Trace workspace packages from the monorepo root into the standalone bundle.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  transpilePackages: ['@orbit/api-client', '@orbit/shared-constants', '@orbit/validation'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Headers for every response, including static assets. The CSP (with its per-request nonce) and
  // HSTS are set in src/proxy.js.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
  async rewrites() {
    // Dev convenience so the browser stays same-origin without Nginx. In production Nginx
    // routes /api and /socket.io before requests reach Next.js.
    return [
      { source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` },
      { source: '/socket.io/:path*', destination: `${apiInternalUrl}/socket.io/:path*` },
    ];
  },
};

export default nextConfig;
