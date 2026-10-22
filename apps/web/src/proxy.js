import { NextResponse } from 'next/server';

/**
 * Content Security Policy with a fresh nonce per request (docs/security-privacy.md). Next.js reads
 * the nonce from the request's CSP header and puts it on its own scripts; any other script is
 * blocked ('strict-dynamic' lets those scripts load their chunks). Styles allow inline because
 * charts, toasts and dialogs set style attributes; that is far less dangerous than inline script.
 * Browsers talk to object storage directly through presigned URLs, so its origin(s) are allowed
 * for images and uploads (CSP_STORAGE_ORIGINS, space-separated, read at runtime). A realtime server on
 * another origin (NEXT_PUBLIC_REALTIME_URL; same-origin in production) is allowed for sockets.
 */
export function buildCsp({ nonce, storageOrigins = '', realtimeUrl = '', https = false, dev = false }) {
  const storage = storageOrigins.split(/\s+/).filter(Boolean).join(' ');
  let realtime = '';
  if (realtimeUrl) {
    const { origin, protocol, host } = new URL(realtimeUrl);
    realtime = ` ${origin} ${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
  }
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data:${storage ? ` ${storage}` : ''}`,
    "font-src 'self'",
    `connect-src 'self'${storage ? ` ${storage}` : ''}${realtime}${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}

export function proxy(request) {
  const nonce = btoa(crypto.randomUUID());
  const https = request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const csp = buildCsp({ nonce, storageOrigins: process.env.CSP_STORAGE_ORIGINS, realtimeUrl: process.env.NEXT_PUBLIC_REALTIME_URL, https, dev: process.env.NODE_ENV === 'development' });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  if (https) response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: the API, sockets and static assets do not render HTML.
      source: '/((?!api|socket.io|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
