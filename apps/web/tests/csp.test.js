import { describe, expect, it } from 'vitest';
import { buildCsp } from '@/proxy';

describe('Content-Security-Policy', () => {
  it('allows only nonce-bearing scripts and never eval in production', () => {
    const csp = buildCsp({ nonce: 'abc' });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('adds storage origins for presigned images and uploads, and the realtime origin for sockets', () => {
    const csp = buildCsp({ nonce: 'n', storageOrigins: 'https://s3.example.com  https://cdn.example.com', realtimeUrl: 'https://rt.example.com/socket', https: true });
    expect(csp).toContain("img-src 'self' blob: data: https://s3.example.com https://cdn.example.com");
    expect(csp).toContain("connect-src 'self' https://s3.example.com https://cdn.example.com https://rt.example.com wss://rt.example.com");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('permits eval and dev sockets only in development', () => {
    expect(buildCsp({ nonce: 'n', dev: true })).toContain("'unsafe-eval'");
  });
});
