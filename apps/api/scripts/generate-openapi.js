// Writes openapi/openapi.json from the route registry. CI regenerates it and fails on drift.
import { writeFileSync } from 'node:fs';
import { buildApiRouter } from '../src/routes/index.js';
import { listRoutes } from '../src/routes/define-routes.js';
import { buildOpenApiDocument } from '../src/modules/docs/openapi.js';

// Building the router registers every route; handlers are never invoked, so no deps are needed.
buildApiRouter({}, {});
const document = buildOpenApiDocument(listRoutes());
writeFileSync(new URL('../openapi/openapi.json', import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
console.warn(`openapi.json written: ${Object.keys(document.paths).length} paths, ${listRoutes().length} operations`);
