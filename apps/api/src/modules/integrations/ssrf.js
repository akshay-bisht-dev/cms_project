import { lookup as dnsLookup } from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';

// Address ranges a webhook must never reach (loopback, private, link-local, metadata, CGNAT…).
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4ToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isBlockedAddress(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

/** Checks a webhook URL's shape: HTTPS (plain HTTP only when explicitly allowed), no credentials. */
export function validateWebhookUrl(raw, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full URL such as https://example.com/hooks/orbit';
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return 'Webhook URLs must use https://';
  if (url.username || url.password) return 'Put credentials in your receiver, not the URL';
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ''))) return 'This address is not allowed';
  return null;
}

/**
 * POSTs to a webhook URL. The DNS lookup is checked at connect time, so a hostname that resolves
 * (or later re-resolves) to a private address is refused — this also defeats DNS rebinding.
 * Redirects are never followed. Resolves to { status, ms } or rejects.
 */
export function postWebhook(url, { headers, body, timeoutMs = 10_000, lookup = dnsLookup, allowPrivate = false }) {
  const target = new URL(url);
  const guardedLookup = (hostname, options, callback) => {
    lookup(hostname, { ...options, all: false }, (err, address, family) => {
      if (err) return callback(err);
      if (!allowPrivate && isBlockedAddress(address)) return callback(Object.assign(new Error(`Refused to connect to a private address (${address})`), { code: 'EBLOCKED' }));
      callback(null, address, family);
    });
  };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).request(target, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, lookup: guardedLookup, timeout: timeoutMs }, (res) => {
      res.resume(); // the body is not used; drain it
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - started }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}
