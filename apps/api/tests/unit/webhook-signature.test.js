import { describe, expect, it } from 'vitest';
import { signPayload, verifyWebhook } from '../../src/modules/integrations/webhook-signature.js';
import { isBlockedAddress, validateWebhookUrl } from '../../src/modules/integrations/ssrf.js';

const secret = 'whsec_test';
const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { total: '100.00' } });
const now = Date.parse('2026-10-21T10:00:00Z');
const ts = now / 1000;
const headers = (over = {}) => ({ 'X-Orbit-Timestamp': String(ts), 'X-Orbit-Delivery': 'dlv_1', 'X-Orbit-Signature': signPayload({ secret, timestamp: ts, deliveryId: 'dlv_1', body }), ...over });

describe('webhook signatures', () => {
  it('verifies a genuine delivery and returns the event', () => {
    expect(verifyWebhook({ secret, headers: headers(), body, now })).toMatchObject({ type: 'invoice.paid' });
  });

  it('rejects tampered bodies, wrong secrets and altered headers', () => {
    expect(() => verifyWebhook({ secret, headers: headers(), body: body.replace('100.00', '1.00'), now })).toThrow(/Signature/);
    expect(() => verifyWebhook({ secret: 'whsec_other', headers: headers(), body, now })).toThrow(/Signature/);
    // The timestamp and delivery id are signed: changing them breaks the signature.
    expect(() => verifyWebhook({ secret, headers: headers({ 'X-Orbit-Timestamp': String(ts + 1) }), body, now })).toThrow(/Signature/);
    expect(() => verifyWebhook({ secret, headers: headers({ 'X-Orbit-Delivery': 'dlv_2' }), body, now })).toThrow(/Signature/);
    expect(() => verifyWebhook({ secret, headers: { ...headers(), 'X-Orbit-Signature': undefined }, body, now })).toThrow();
  });

  it('rejects stale timestamps and replayed delivery ids', () => {
    expect(() => verifyWebhook({ secret, headers: headers(), body, now: now + 301_000 })).toThrow(/tolerance/);
    const seen = new Set();
    verifyWebhook({ secret, headers: headers(), body, now, seen });
    expect(() => verifyWebhook({ secret, headers: headers(), body, now, seen })).toThrow(/replay/);
  });
});

describe('SSRF guard', () => {
  it('blocks private, loopback, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('requires https and refuses literal private hosts and embedded credentials', () => {
    expect(validateWebhookUrl('https://hooks.example.com/orbit')).toBeNull();
    expect(validateWebhookUrl('http://hooks.example.com/orbit')).toMatch(/https/);
    expect(validateWebhookUrl('https://127.0.0.1/x')).toMatch(/not allowed/);
    expect(validateWebhookUrl('https://[::1]/x')).toMatch(/not allowed/);
    expect(validateWebhookUrl('https://user:pass@example.com/x')).toMatch(/credentials/);
    expect(validateWebhookUrl('not a url')).toMatch(/full URL/);
  });
});
