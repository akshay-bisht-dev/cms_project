import { hashPassword } from '../../src/services/passwords.js';
import { withTransaction } from '../../src/repositories/tx.js';
import { createOrganizationWithOwner } from '../../src/modules/organizations/organizations.service.js';
import { createClient } from './test-app.js';

export const PASSWORD = 'Correct-Horse-Battery-1';
let hashPromise;
const passwordHash = () => (hashPromise ??= hashPassword(PASSWORD));

let counter = 0;
const unique = (prefix) => `${prefix}-${process.pid}-${++counter}`;

/** Creates an ACTIVE organization with a verified owner. Returns { org, owner, roles }. */
export async function createOrg(prisma, { name, ownerEmail, seatLimit = null, status = 'ACTIVE' } = {}) {
  const slug = unique('org');
  const hash = await passwordHash();
  return withTransaction(prisma, async (tx) => {
    const owner = await tx.user.create({
      data: { email: ownerEmail ?? `${slug}-owner@example.test`, name: `${name ?? slug} Owner`, passwordHash: hash, emailVerifiedAt: new Date() },
    });
    const { organization, member, roles } = await createOrganizationWithOwner(tx, {
      name: name ?? slug,
      slug,
      timeZone: 'UTC',
      baseCurrency: 'USD',
      status,
      ownerUserId: owner.id,
    });
    if (seatLimit !== null) await tx.organization.update({ where: { id: organization.id }, data: { seatLimit } });
    return { org: organization, owner: { ...owner, employeeId: member.id }, roles };
  });
}

/**
 * Adds an ACTIVE, verified member with the given system role (or none) and profile fields.
 * Returns { user, member, employeeId }.
 */
export async function createMember(prisma, { org, roles }, { role = 'EMPLOYEE', email, name, status = 'ACTIVE', profile = {} } = {}) {
  const hash = await passwordHash();
  const handle = unique('member');
  return withTransaction(prisma, async (tx) => {
    const user =
      (email && (await tx.user.findUnique({ where: { email } }))) ||
      (await tx.user.create({ data: { email: email ?? `${handle}@example.test`, name: name ?? handle, passwordHash: hash, emailVerifiedAt: new Date() } }));
    const member = await tx.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, status, joinedAt: status === 'ACTIVE' ? new Date() : null },
    });
    await tx.employeeProfile.create({ data: { organizationId: org.id, userId: user.id, ...profile } });
    if (role) await tx.memberRole.create({ data: { organizationId: org.id, userId: user.id, roleId: roles[role].id } });
    return { user, member, employeeId: member.id };
  });
}

/** Signs in through the real login endpoint and returns a client with cookies and CSRF set. */
export async function login(app, email, { password = PASSWORD, organizationId } = {}) {
  const client = createClient(app);
  const res = await client.post('/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  if (organizationId && res.body.data.status === 'ORGANIZATION_SELECTION_REQUIRED') {
    const selected = await client.post('/auth/select-organization', { organizationId });
    if (selected.status !== 200) throw new Error(`select-organization failed: ${JSON.stringify(selected.body)}`);
  }
  client.loginResponse = res;
  return client;
}

/** Latest outbox email payload sent to an address (the worker is not running in tests). */
export async function lastEmail(prisma, cipher, to) {
  const events = await prisma.outboxEvent.findMany({ where: { type: 'email.send' }, orderBy: { createdAt: 'desc' } });
  const event = events.find((e) => e.payload.to === to);
  if (!event) return null;
  const link = event.payload.linkEnc ? cipher.decrypt(event.payload.linkEnc) : null;
  return { ...event.payload, link, token: link ? new URL(link).searchParams.get('token') : null };
}
