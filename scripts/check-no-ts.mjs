// Fails if any TypeScript source file exists in the repository (vendor files excluded).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.next', '.next-e2e', '.git', 'dist', 'coverage', '.local', 'playwright-report', 'test-results']);
const offenders = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) offenders.push(path);
  }
}

await walk(process.cwd());
if (offenders.length) {
  console.error(`TypeScript files are not allowed:\n${offenders.join('\n')}`);
  process.exit(1);
}
console.warn('check-no-ts: OK (no TypeScript files)');
