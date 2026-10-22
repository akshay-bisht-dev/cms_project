import { z } from 'zod';
import { API_PREFIX } from '@orbit/shared-constants';
import { AGENT, MEMBER, PUBLIC, SESSION } from '../../middleware/authorize.js';

function toJsonSchema(schema) {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' });
}

function parametersFrom(schema, location) {
  if (!schema) return [];
  const json = toJsonSchema(schema);
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: propertySchema,
  }));
}

function accessDescription(permission) {
  if (permission === PUBLIC) return 'Public.';
  if (permission === SESSION) return 'Requires a signed-in session.';
  if (permission === MEMBER) return 'Requires an active membership in the session organization.';
  if (permission === AGENT) return 'Requires a desktop agent access token (Authorization: Bearer). Browser sessions are refused.';
  return `Requires permission \`${permission}\` (scope checked against the target).`;
}

const ENVELOPE_ERROR = {
  type: 'object',
  required: ['success', 'error', 'requestId'],
  properties: {
    success: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message', 'details'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
    requestId: { type: 'string' },
  },
};

/** Builds an OpenAPI 3.1 document from the route registry and its Zod schemas. */
export function buildOpenApiDocument(routes, { version = '0.3.0' } = {}) {
  const paths = {};
  for (const route of [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    const openApiPath = `${API_PREFIX}${route.path}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/$/, '') || '/';
    const operation = {
      summary: route.summary,
      tags: route.tags ?? [],
      description: [
        accessDescription(route.permission),
        route.idempotent ? 'Requires an `Idempotency-Key` header.' : null,
        route.rateLimit ? `Rate-limit class: \`${route.rateLimit}\`.` : null,
        route.apiKey ? 'Also accepts an API key (`Authorization: Bearer orb_…`), limited to its scopes.' : null,
      ]
        .filter(Boolean)
        .join(' '),
      'x-permission': route.permission,
      'x-api-key': Boolean(route.apiKey),
      parameters: [...parametersFrom(route.params, 'path'), ...parametersFrom(route.query, 'query')],
      responses: {
        default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        200: { description: 'Success: `{ success: true, data, meta }`' },
      },
    };
    if (route.idempotent) {
      operation.parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } });
    }
    if (route.body) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: toJsonSchema(route.body) } } };
    }
    if (route.permission === AGENT) operation.security = [{ agentToken: [] }];
    else if (route.permission !== PUBLIC) operation.security = [{ sessionCookie: [], csrfHeader: [] }, ...(route.apiKey ? [{ apiKey: [] }] : [])];
    paths[openApiPath] ??= {};
    paths[openApiPath][route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Orbit API',
      version,
      description: 'Generated from route declarations and Zod schemas. Responses use the envelope documented in docs/api-reference.md.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'orbit_sid' },
        csrfHeader: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
        agentToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'orb_<prefix>_<secret>' },
      },
      schemas: { Error: ENVELOPE_ERROR },
    },
    paths,
  };
}
