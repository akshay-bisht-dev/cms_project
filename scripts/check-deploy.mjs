// Static checks for deployment configuration (part of `pnpm lint`). Docker and Kubernetes are not
// needed: every compose file, Kubernetes manifest and workflow is parsed and held to the hardening
// rules in docs/security-checklist.md. Exits 1 with one line per problem.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];
const fail = (file, msg) => problems.push(`${relative(root, file)}: ${msg}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ya?ml$/.test(name)) out.push(p);
  }
  return out;
}

function load(file) {
  // merge: resolve YAML "<<:" merge keys, as Docker Compose does.
  const docs = parseAllDocuments(readFileSync(file, 'utf8'), { merge: true });
  for (const d of docs) if (d.errors.length) fail(file, `YAML error: ${d.errors[0].message}`);
  return docs.map((d) => d.toJS()).filter(Boolean);
}

const SECRETISH = /(PASSWORD|SECRET|_KEY$|KEY_ID$|TOKEN|DATABASE_URL|REDIS_URL|_ADMIN_URL$)/;
const pinned = (image) => typeof image === 'string' && /:[^/]+$/.test(image) && !image.endsWith(':latest');

// --- Kubernetes ---------------------------------------------------------------------------------------
const k8sDir = join(root, 'infrastructure/k8s');
const podSpecOf = (doc) =>
  doc.kind === 'Deployment' || doc.kind === 'Job' ? doc.spec?.template?.spec : doc.kind === 'CronJob' ? doc.spec?.jobTemplate?.spec?.template?.spec : null;
let namespaces = 0;
for (const file of walk(k8sDir)) {
  const isExample = file.endsWith('.example.yaml');
  for (const doc of load(file)) {
    if (doc.kind === 'Namespace') {
      namespaces += 1;
      if (doc.metadata?.labels?.['pod-security.kubernetes.io/enforce'] !== 'restricted') fail(file, `namespace ${doc.metadata?.name} must enforce the "restricted" pod security standard`);
    }
    if (doc.kind === 'Secret' && !isExample) fail(file, `Secret ${doc.metadata?.name} must not be committed (use your secret manager)`);
    const spec = podSpecOf(doc);
    if (!spec) continue;
    const where = `${doc.kind} ${doc.metadata?.name}`;
    if (spec.automountServiceAccountToken !== false) fail(file, `${where}: automountServiceAccountToken must be false`);
    const pod = spec.securityContext ?? {};
    if (pod.runAsNonRoot !== true || !(pod.runAsUser > 0)) fail(file, `${where}: must run as a numeric non-root user`);
    if (pod.seccompProfile?.type !== 'RuntimeDefault') fail(file, `${where}: seccompProfile must be RuntimeDefault`);
    for (const c of spec.containers ?? []) {
      const name = `${where}/${c.name}`;
      const sc = c.securityContext ?? {};
      if (sc.allowPrivilegeEscalation !== false) fail(file, `${name}: allowPrivilegeEscalation must be false`);
      if (sc.readOnlyRootFilesystem !== true) fail(file, `${name}: readOnlyRootFilesystem must be true`);
      if (!sc.capabilities?.drop?.includes('ALL')) fail(file, `${name}: must drop ALL capabilities`);
      if (!c.resources?.requests?.memory || !c.resources?.limits?.memory) fail(file, `${name}: memory request and limit required`);
      if (!pinned(c.image)) fail(file, `${name}: image must have an explicit tag other than latest`);
      if (doc.kind === 'Deployment' && !c.livenessProbe && !c.readinessProbe) fail(file, `${name}: needs a liveness or readiness probe`);
      for (const e of c.env ?? []) if (SECRETISH.test(e.name) && e.value !== undefined) fail(file, `${name}: ${e.name} must come from a Secret, not a literal value`);
    }
  }
}
if (!namespaces) fail(k8sDir, 'no Namespace manifest found');

// --- Compose -------------------------------------------------------------------------------------------
const prodFile = join(root, 'docker-compose.prod.yml');
const [prod] = load(prodFile);
for (const [name, svc] of Object.entries(prod?.services ?? {})) {
  if (svc.ports?.length && name !== 'nginx') fail(prodFile, `${name}: only nginx may publish ports`);
  if (!svc.image) fail(prodFile, `${name}: production services use registry images, never build`);
  else if (!/\$\{ORBIT_VERSION/.test(svc.image) && !pinned(svc.image)) fail(prodFile, `${name}: image must be pinned`);
  if (svc.build) fail(prodFile, `${name}: must not build in production`);
  const isDataStore = ['mysql', 'redis'].includes(name);
  if (!isDataStore && svc.read_only !== true) fail(prodFile, `${name}: read_only root filesystem required`);
  if (!isDataStore && !svc.cap_drop?.includes('ALL')) fail(prodFile, `${name}: must drop ALL capabilities`);
  if (!svc.profiles && !svc.healthcheck) fail(prodFile, `${name}: long-running services need a healthcheck`);
  const env = Array.isArray(svc.environment) ? Object.fromEntries(svc.environment.map((e) => e.split('='))) : (svc.environment ?? {});
  for (const k of Object.keys(env)) if (SECRETISH.test(k)) fail(prodFile, `${name}: ${k} belongs in an env_file outside the repository`);
}
const devFile = join(root, 'docker-compose.yml');
const [dev] = load(devFile);
for (const name of ['mysql', 'redis', 's3', 'mailpit']) {
  for (const p of dev?.services?.[name]?.ports ?? []) if (!String(p).startsWith('127.0.0.1:')) fail(devFile, `${name}: development ports must bind to 127.0.0.1`);
}

// --- GitHub Actions ------------------------------------------------------------------------------------
for (const file of walk(join(root, '.github/workflows'))) {
  const [wf] = load(file);
  if (!wf?.permissions) fail(file, 'set top-level permissions explicitly (least privilege)');
  for (const [id, job] of Object.entries(wf?.jobs ?? {})) {
    for (const step of job.steps ?? []) if (step.uses && !/@[\w.-]+$/.test(step.uses)) fail(file, `${id}: "${step.uses}" must reference a version`);
  }
}

if (problems.length) {
  process.stderr.write(`check-deploy: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('check-deploy: OK (compose, Kubernetes and workflows)\n');
