import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Every route declared through `defineRoutes`, keyed by "METHOD path" (OpenAPI + route-coverage tests). */
const registry = new Map();

export function listRoutes() {
  return [...registry.values()];
}

/**
 * Declarative routes: each states its access level and schemas. A route without a permission
 * is a programming error and fails at startup.
 *
 *   defineRoutes('/teams', (r) => {
 *     r.post('/', { permission: 'teams.manage', body: createTeamSchema, summary: 'Create a team' }, handler);
 *   });
 *
 * Options: permission (PUBLIC | SESSION | MEMBER | permission key), params, query, body,
 * summary, tags, idempotent, rateLimit, allowMfaPending, allowMfaEnrollment, allowClient
 * (client portal users may call it), apiKey (API keys may call it), successStatus.
 */
export function defineRoutes(basePath, register) {
  const routes = [];
  const api = {};
  for (const method of METHODS) {
    api[method] = (path, options, handler) => {
      if (!options?.permission) {
        throw new Error(`Route ${method.toUpperCase()} ${basePath}${path} must declare a permission`);
      }
      const route = { method, path, fullPath: `${basePath}${path}`, options, handler };
      routes.push(route);
      registry.set(`${method.toUpperCase()} ${route.fullPath}`, { method, path: route.fullPath, ...options });
    };
  }
  register(api);
  return { basePath, routes };
}

/**
 * Builds an Express router for a module. `extras` supplies infrastructure middleware factories:
 *   rateLimit(className) and idempotency().
 * Order: rate limit → authorize → validate → idempotency → handler.
 */
export function mountModule({ basePath, routes }, extras = {}) {
  const router = Router();
  for (const { method, path, options, handler } of routes) {
    const chain = [];
    const limitClass = options.rateLimit ?? (method === 'get' ? 'read' : 'write');
    if (extras.rateLimit && limitClass !== 'none') {
      // API-key traffic has its own budget per key, whatever the route.
      const normal = extras.rateLimit(limitClass);
      const forKeys = options.apiKey ? extras.rateLimit('api-key') : null;
      chain.push(forKeys ? (req, res, next) => (req.ctx?.apiKey ? forKeys : normal)(req, res, next) : normal);
    }
    chain.push(authorize(options.permission, options));
    chain.push(validate({ params: options.params, query: options.query, body: options.body }));
    if (options.idempotent && extras.idempotency) chain.push(extras.idempotency());
    chain.push(handler);
    router[method](path, ...chain);
  }
  return { basePath, router };
}
