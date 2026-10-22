// Development seed: two organizations (to exercise tenant isolation), each with departments,
// a team, and one active user per system role. Idempotent: re-running fills in anything missing
// (including system roles for organizations created before RBAC existed) and never deletes data.
import { randomBytes } from 'node:crypto';
import { createPrisma } from '../src/repositories/prisma.js';
import { hashPassword } from '../src/services/passwords.js';
import { withTransaction } from '../src/repositories/tx.js';
import { syncPermissionCatalog } from '../src/modules/rbac/index.js';
import { createSystemRoles } from '../src/modules/rbac/rbac.service.js';
import { createOrganizationWithOwner } from '../src/modules/organizations/organizations.service.js';
import { withCompletion } from '../src/modules/employees/fields.js';
import { DEFAULT_STATUSES } from '../src/modules/projects/projects.service.js';

if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
  console.error('Refusing to seed a production environment.');
  process.exit(1);
}

const prisma = createPrisma();
const password = process.env.SEED_PASSWORD || randomBytes(9).toString('base64url');

const ORGS = [
  { slug: 'acme-it', name: 'Acme IT Services', timeZone: 'Asia/Kolkata', baseCurrency: 'INR', domain: 'acme-it.test' },
  { slug: 'globex', name: 'Globex Consulting', timeZone: 'America/New_York', baseCurrency: 'USD', domain: 'globex.test' },
];

const DEPARTMENTS = [
  ['ENG', 'Engineering'],
  ['PEOPLE', 'People Operations'],
  ['FIN', 'Finance'],
];

const PEOPLE = [
  { local: 'hr', name: 'Hana Rao', role: 'HR_MANAGER', designation: 'HR Manager', dept: 'PEOPLE' },
  { local: 'pm', name: 'Priya Menon', role: 'PROJECT_MANAGER', designation: 'Delivery Manager', dept: 'ENG' },
  { local: 'lead', name: 'Tomás Lee', role: 'TEAM_LEAD', designation: 'Engineering Lead', dept: 'ENG' },
  { local: 'dev1', name: 'Dev Patel', role: 'EMPLOYEE', designation: 'Software Engineer', dept: 'ENG', manager: 'lead' },
  { local: 'dev2', name: 'Elena Novak', role: 'EMPLOYEE', designation: 'QA Engineer', dept: 'ENG', manager: 'lead' },
  { local: 'finance', name: 'Farah Khan', role: 'FINANCE_MANAGER', designation: 'Finance Manager', dept: 'FIN' },
];

function upsertUser(tx, email, name, passwordHash) {
  return tx.user.upsert({
    where: { email },
    update: { passwordHash, name, emailVerifiedAt: new Date() },
    create: { email, name, passwordHash, emailVerifiedAt: new Date(), passwordChangedAt: new Date() },
  });
}

async function ensureMember(tx, organizationId, user, roleId, profile) {
  const key = { organizationId_userId: { organizationId, userId: user.id } };
  await tx.organizationMember.upsert({
    where: key,
    update: { status: 'ACTIVE' },
    create: { organizationId, userId: user.id, status: 'ACTIVE', joinedAt: new Date() },
  });
  const existing = await tx.employeeProfile.findUnique({ where: key });
  const merged = withCompletion({ ...(existing ?? {}), ...profile });
  const data = { ...profile, completionPct: merged.completionPct };
  await tx.employeeProfile.upsert({ where: key, update: data, create: { organizationId, userId: user.id, ...data } });
  await tx.memberRole.createMany({ data: [{ organizationId, userId: user.id, roleId }], skipDuplicates: true });
}

async function ensureRoles(tx, organizationId) {
  const existing = await tx.role.findMany({ where: { organizationId } });
  if (existing.length) return Object.fromEntries(existing.map((r) => [r.key, r]));
  return createSystemRoles(tx, organizationId);
}

async function seedOrganization(spec, passwordHash) {
  await withTransaction(
    prisma,
    async (tx) => {
      const owner = await upsertUser(tx, `owner@${spec.domain}`, `${spec.name.split(' ')[0]} Owner`, passwordHash);
      let org = await tx.organization.findUnique({ where: { slug: spec.slug } });
      let roles;
      if (!org) {
        ({ organization: org, roles } = await createOrganizationWithOwner(tx, { ...spec, status: 'ACTIVE', ownerUserId: owner.id }));
      } else {
        await tx.organizationSettings.upsert({ where: { organizationId: org.id }, update: {}, create: { organizationId: org.id, data: {} } });
        roles = await ensureRoles(tx, org.id);
        await ensureMember(tx, org.id, owner, roles.OWNER.id, { timeZone: spec.timeZone });
      }

      const departments = {};
      for (const [code, name] of DEPARTMENTS) {
        departments[code] = await tx.department.upsert({
          where: { organizationId_code: { organizationId: org.id, code } },
          update: {},
          create: { organizationId: org.id, code, name },
        });
      }

      const users = {};
      for (const person of PEOPLE) {
        users[person.local] = await upsertUser(tx, `${person.local}@${spec.domain}`, person.name, passwordHash);
        await ensureMember(tx, org.id, users[person.local], roles[person.role].id, {
          designation: person.designation,
          departmentId: departments[person.dept].id,
          employmentType: 'FULL_TIME',
          employeeCode: `${spec.slug.slice(0, 3).toUpperCase()}-${person.local.toUpperCase()}`,
          timeZone: spec.timeZone,
        });
      }
      for (const person of PEOPLE.filter((p) => p.manager)) {
        const where = { organizationId_userId: { organizationId: org.id, userId: users[person.local].id } };
        const current = await tx.employeeProfile.findUnique({ where });
        await tx.employeeProfile.update({ where, data: withCompletion({ ...current, managerUserId: users[person.manager].id }) });
      }
      await tx.department.updateMany({ where: { organizationId: org.id, id: departments.ENG.id }, data: { managerUserId: users.pm.id } });
      await tx.department.updateMany({ where: { organizationId: org.id, id: departments.PEOPLE.id }, data: { managerUserId: users.hr.id } });

      const team = await tx.team.upsert({
        where: { organizationId_name: { organizationId: org.id, name: 'Platform' } },
        update: { leadUserId: users.lead.id },
        create: { organizationId: org.id, name: 'Platform', departmentId: departments.ENG.id, leadUserId: users.lead.id },
      });
      await tx.teamMember.createMany({
        data: ['lead', 'dev1', 'dev2'].map((local) => ({ organizationId: org.id, teamId: team.id, userId: users[local].id })),
        skipDuplicates: true,
      });
      await seedProjects(tx, org.id, users);
      await seedCrm(tx, org, users, passwordHash, spec.domain);
    },
    { timeout: 60_000 },
  );
  console.log(`seeded ${spec.slug}: owner@${spec.domain}, ${PEOPLE.map((p) => `${p.local}@${spec.domain}`).join(', ')}`);
}

const isoIn = (days) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + days));

const PROJECTS = [
  {
    code: 'PORTAL',
    name: 'Customer Portal',
    manager: 'pm',
    members: ['lead', 'dev1', 'dev2'],
    visibility: 'ORG',
    estimatedH: 400,
    milestone: { name: 'Beta release', dueIn: 14 },
    tasks: [
      { title: 'Design login screens', status: 'Done', who: ['dev2'], dueIn: -5, estimateH: 8 },
      { title: 'Implement OAuth sign-in', status: 'In progress', who: ['dev1'], dueIn: 3, estimateH: 16, priority: 'HIGH' },
      { title: 'Write API integration tests', status: 'To do', who: ['dev2'], dueIn: 6, estimateH: 12 },
      { title: 'Fix session timeout bug', status: 'In review', who: ['dev1'], dueIn: -1, estimateH: 4, priority: 'URGENT' },
      { title: 'Accessibility audit', status: 'To do', who: [], dueIn: 10, estimateH: 6 },
    ],
  },
  {
    code: 'TOOLS',
    name: 'Internal Tools',
    manager: 'lead',
    members: ['dev1'],
    visibility: 'PRIVATE',
    estimatedH: 120,
    tasks: [{ title: 'Automate release notes', status: 'To do', who: ['dev1'], dueIn: 9, estimateH: 5 }],
  },
];

/** Demo projects with a workflow, a milestone and tasks in different states (skipped if present). */
async function seedProjects(tx, organizationId, users) {
  for (const spec of PROJECTS) {
    if (await tx.project.findFirst({ where: { organizationId, code: spec.code } })) continue;
    const project = await tx.project.create({
      data: {
        organizationId,
        code: spec.code,
        name: spec.name,
        status: 'ACTIVE',
        visibility: spec.visibility,
        managerUserId: users[spec.manager].id,
        estimatedS: spec.estimatedH * 3600,
        startDate: isoIn(-30),
        deadline: isoIn(60),
        nextTaskNumber: spec.tasks.length + 1,
      },
    });
    await tx.projectMember.createMany({
      data: [
        { organizationId, projectId: project.id, userId: users[spec.manager].id, role: 'MANAGER' },
        ...spec.members.map((m) => ({ organizationId, projectId: project.id, userId: users[m].id, role: 'MEMBER' })),
      ],
    });
    const statuses = {};
    for (const [sort, st] of DEFAULT_STATUSES.entries()) {
      statuses[st.name] = await tx.taskStatus.create({ data: { organizationId, projectId: project.id, ...st, sort } });
    }
    const milestone = spec.milestone
      ? await tx.milestone.create({ data: { organizationId, projectId: project.id, name: spec.milestone.name, dueDate: isoIn(spec.milestone.dueIn) } })
      : null;
    for (const [i, t] of spec.tasks.entries()) {
      const task = await tx.task.create({
        data: {
          organizationId,
          projectId: project.id,
          number: i + 1,
          statusId: statuses[t.status].id,
          title: t.title,
          priority: t.priority ?? 'MEDIUM',
          dueDate: isoIn(t.dueIn),
          startDate: isoIn(t.dueIn - 4),
          estimatedS: t.estimateH * 3600,
          milestoneId: milestone?.id ?? null,
          sort: (i + 1) * 1024,
          completedAt: t.status === 'Done' ? new Date() : null,
          createdById: users[spec.manager].id,
        },
      });
      if (t.who.length) await tx.taskAssignee.createMany({ data: t.who.map((w) => ({ organizationId, taskId: task.id, userId: users[w].id })) });
    }
  }
}

/**
 * CRM & finance demo data (skipped if present): a client that owns the PORTAL project and has a
 * portal user, a lead, an organization billing rate, an expense category and an open ticket.
 */
async function seedCrm(tx, org, users, passwordHash, domain) {
  if (await tx.client.findFirst({ where: { organizationId: org.id, code: 'INITECH' } })) return;
  const client = await tx.client.create({
    data: { organizationId: org.id, code: 'INITECH', name: 'Initech Ltd', status: 'ACTIVE', defaultCurrency: org.baseCurrency, paymentTermsDays: 30, email: 'accounts@initech.test', accountManagerId: users.pm.id },
  });
  await tx.clientContact.create({ data: { organizationId: org.id, clientId: client.id, name: 'Bill Lumbergh', email: `client@${domain}`, title: 'VP Operations', isPrimary: true } });
  await tx.project.updateMany({ where: { organizationId: org.id, code: 'PORTAL' }, data: { clientId: client.id, sharedWithClient: true } });

  const portalUser = await upsertUser(tx, `client@${domain}`, 'Bill Lumbergh', passwordHash);
  const clientRole = await tx.role.findFirst({ where: { organizationId: org.id, key: 'CLIENT_USER' } });
  await tx.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: portalUser.id } },
    update: {},
    create: { organizationId: org.id, userId: portalUser.id, memberType: 'CLIENT', clientId: client.id, status: 'ACTIVE', joinedAt: new Date() },
  });
  await tx.memberRole.createMany({ data: [{ organizationId: org.id, userId: portalUser.id, roleId: clientRole.id }], skipDuplicates: true });

  await tx.lead.create({ data: { organizationId: org.id, name: 'Peter Gibbons', company: 'Chotchkies', email: 'peter@chotchkies.test', source: 'Referral', ownerId: users.pm.id, status: 'CONTACTED', estimatedValue: '18000', currency: org.baseCurrency } });
  await tx.billingRate.create({ data: { organizationId: org.id, kind: 'BILL', targetType: 'ORG', amount: '95', currency: org.baseCurrency, effectiveFrom: isoIn(-365) } });
  await tx.expenseCategory.createMany({ data: ['Travel', 'Meals', 'Software'].map((name) => ({ organizationId: org.id, name })), skipDuplicates: true });
  const sla = await tx.slaPolicy.create({
    data: { organizationId: org.id, name: 'Standard', isDefault: true, targets: { URGENT: { firstResponseMin: 60, resolutionMin: 240 }, HIGH: { firstResponseMin: 240, resolutionMin: 1440 }, NORMAL: { firstResponseMin: 480, resolutionMin: 2880 }, LOW: { firstResponseMin: 1440, resolutionMin: 7200 } } },
  });
  const now = new Date();
  await tx.documentSequence.upsert({ where: { organizationId_name: { organizationId: org.id, name: 'TICKET' } }, update: {}, create: { organizationId: org.id, name: 'TICKET', nextValue: 2 } });
  await tx.supportTicket.create({
    data: { organizationId: org.id, number: 1, clientId: client.id, reporterId: portalUser.id, subject: 'Cannot export TPS reports', description: 'The export button does nothing.', priority: 'HIGH', assigneeId: users.dev1.id, slaPolicyId: sla.id, firstResponseDueAt: new Date(now.getTime() + 4 * 3600_000), resolutionDueAt: new Date(now.getTime() + 24 * 3600_000) },
  });
}

try {
  await syncPermissionCatalog(prisma);
  const passwordHash = await hashPassword(password);
  for (const spec of ORGS) await seedOrganization(spec, passwordHash);
  // Leave balances: credit this year's accruals (idempotent; the worker does this daily).
  const { runAccruals } = await import('../src/modules/leave/jobs.js');
  await runAccruals({ prisma, clock: { now: () => new Date() } });
  console.log(`\nDev password for seeded users: ${password}\n(set SEED_PASSWORD to choose your own)`);
} finally {
  await prisma.$disconnect();
}
