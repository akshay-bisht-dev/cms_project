# Integrating with Orbit

Two ways to connect another system: **webhooks** (Orbit calls you when something happens) and
**API keys** (you call Orbit). Both are managed under **Settings → Integrations**, and every change
is recorded in the audit log.

## Webhooks

### Events
| Event | When |
|---|---|
| `employee.created` · `employee.deactivated` | An employee is added; deactivated or offboarded |
| `leave.approved` · `leave.cancelled` | A leave request completes its approval chain; approved leave is cancelled |
| `project.created` · `task.completed` | — |
| `timesheet.approved` · `expense.approved` | — |
| `client.created` | — |
| `ticket.created` · `ticket.resolved` | — |
| `invoice.issued` · `invoice.paid` | An invoice gets its number; payments cover the total |
| `ping` | Sent to one webhook by **Test** in the UI, whatever its event list |

`GET /api/v1/webhooks/events` returns the current list.

Events are written in the same database transaction as the change (an outbox), so you are only
told about changes that were committed. Delivery is **at least once**: deduplicate on the event `id`.

### Request
```
POST <your URL>
Content-Type: application/json
User-Agent: Orbit-Webhooks/1
X-Orbit-Event: leave.approved
X-Orbit-Delivery: 0199f0c1-…        (same on every retry of a delivery; new on replay)
X-Orbit-Timestamp: 1792600000       (unix seconds)
X-Orbit-Signature: v1=<hex>

{"id":"<event id>","type":"leave.approved","createdAt":"2026-10-21T10:00:00.000Z","organizationId":"…","data":{…}}
```

`data` holds the identifiers of the records involved and a short summary; it varies by event.
Call the API with a key for full records.

### Verifying a delivery
The signature is `HMAC-SHA256(secret, "<timestamp>.<delivery id>.<raw body>")` in hex, prefixed `v1=`.
Because the timestamp and delivery id are signed, an attacker can neither replay an old request
with a fresh timestamp nor reuse a delivery id. To stay safe, a receiver must:

1. compute the HMAC over the **raw** request body (before JSON parsing) and compare in constant time;
2. reject timestamps more than 5 minutes from its clock;
3. remember delivery ids for at least that window and reject repeats — but record an id only **after**
   you have processed the event and are about to answer 2xx. A retry reuses the delivery id, so recording
   it earlier would turn the retry of a failed attempt into a "replay".

Node.js:
```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyOrbitWebhook({ secret, headers, rawBody, seen, toleranceS = 300 }) {
  const timestamp = Number(headers['x-orbit-timestamp']);
  const deliveryId = headers['x-orbit-delivery'];
  if (!Number.isInteger(timestamp) || !deliveryId) throw new Error('missing headers');
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceS) throw new Error('stale');
  const expected = Buffer.from(`v1=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${rawBody}`).digest('hex')}`);
  const given = Buffer.from(String(headers['x-orbit-signature'] ?? ''));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error('bad signature');
  if (seen.has(deliveryId)) throw new Error('replay');
  return { deliveryId, event: JSON.parse(rawBody) }; // after handling it: seen.add(deliveryId), e.g. Redis SET with a 10-minute TTL
}
```
Orbit's own implementation and tests: `apps/api/src/modules/integrations/webhook-signature.js`
(`verifyWebhook`) and `apps/api/tests/unit/webhook-signature.test.js`.

### Responses, retries and replays
- Any **2xx** within 10 seconds is success. Redirects are not followed.
- Otherwise Orbit retries after 1 min, 5 min, 30 min, 2 h and 12 h (6 attempts in total), then marks the delivery failed.
- A webhook is switched off after **20 failed deliveries in a row**. Turning it back on resets the count.
- **Deliveries** in the UI shows the latest 100 attempts with status code, latency and error.
  **Replay** sends the same event again with a new delivery id and signature.
- **New secret** replaces the signing secret immediately. The secret is shown once, when created or rotated.

### Address restrictions
URLs must be `https://` (plain `http://` is accepted only outside production). Addresses that resolve to
private, loopback, link-local, CGNAT or metadata ranges are refused, and the check runs on the address
actually connected to, so DNS rebinding cannot bypass it.

## API keys
- Create a key under **Settings → Integrations**. It is shown once: `orb_<prefix>_<secret>`. Orbit stores only a SHA-256 hash.
- Send it as `Authorization: Bearer orb_…` (no cookie, no CSRF token).
- A key acts **as the person who created it**, limited to the permissions chosen for the key. Both are
  re-checked on every request. If the creator loses a permission or leaves, the key loses it too.
- Only some endpoints accept keys. They are marked `x-api-key: true` in `/api/openapi.json`. Currently these are
  reads of employees, teams, departments, clients, projects, tasks, time entries, timesheets, invoices,
  support tickets (also create) and custom fields. Keys can never manage keys, webhooks or roles.
- Limit: 1,000 requests per hour per key (HTTP 429 with `Retry-After`).
- Keys can expire (30 days to 2 years) and can be revoked at once. Their use appears in the audit log
  with the actor “API key “<name>””.

### Examples
List people page by page (`meta.page.nextCursor` is `null` on the last page):
```bash
curl -s -H "Authorization: Bearer $ORBIT_API_KEY" "https://orbit.example.com/api/v1/employees?limit=100&status=ACTIVE"
# → { "success": true, "data": [ { "employeeId": "…", "name": "…", … } ], "meta": { "page": { "nextCursor": "…", "limit": 100 } } }
curl -s -H "Authorization: Bearer $ORBIT_API_KEY" "https://orbit.example.com/api/v1/employees?limit=100&status=ACTIVE&cursor=<nextCursor>"
```

Open a support ticket from a monitoring system. Writes need an `Idempotency-Key`: retrying with the same
key returns the first result instead of creating a duplicate, and the same key with a different body is
rejected with 409 `IDEMPOTENCY_MISMATCH`:
```bash
curl -s -X POST "https://orbit.example.com/api/v1/support-tickets" \
  -H "Authorization: Bearer $ORBIT_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: alert-7f3c2a" \
  -d '{"subject":"Disk 90% on db-2","description":"Raised by the monitoring system.","priority":"HIGH","clientId":"<client id>"}'
```

Node.js (18+), with paging and backoff on rate limits:
```js
const BASE = 'https://orbit.example.com/api/v1';
const headers = { Authorization: `Bearer ${process.env.ORBIT_API_KEY}` };

async function get(path) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${BASE}${path}`, { headers });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? 1) * 1000));
      continue;
    }
    const body = await res.json();
    if (!body.success) throw new Error(`${body.error.code}: ${body.error.message} (request ${body.requestId})`);
    return body;
  }
}

export async function* allEmployees() {
  let cursor = null;
  do {
    const page = await get(`/employees?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    yield* page.data;
    cursor = page.meta.page.nextCursor;
  } while (cursor);
}

for await (const e of allEmployees()) console.log(e.employeeId, e.name);
```

Errors use one envelope: `{ "success": false, "error": { "code", "message", "details": [{ "path", "message" }] }, "requestId" }`.
Quote the `requestId` when you contact support.
