import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { enqueueEmail } from '../../services/email.js';
import { generateToken, sha256 } from '../../services/crypto.js';
import { withTransaction } from '../../repositories/tx.js';
import { coversMember, hasOrgScope, resolveMemberScope } from '../rbac/rbac.service.js';
import { assertCanAssignRoles, assertOwnerRemains } from '../roles/roles.service.js';
import { resolveEmployeeUserId } from '../shared/members.js';
import { FIELD_GROUPS, GROUP_OF_FIELD, profileCompletion, withCompletion } from './fields.js';
import { notify } from '../notifications/notifications.service.js';
import { csvCell } from '../../utils/csv.js';

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const EXPORT_LIMIT = 5000;
const REDACTED = '[REDACTED]';

const toDate = (iso) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
const fromDate = (d) => (d ? d.toISOString().slice(0, 10) : null);

const memberInclude = {
  user: { select: { id: true, email: true, name: true, lastLoginAt: true, mfa: { select: { enabledAt: true } } } },
  profile: { include: { department: { select: { id: true, name: true } }, manager: { select: { id: true, user: { select: { name: true } } } } } },
  teamMemberships: { include: { team: { select: { id: true, name: true, archivedAt: true } } } },
  roles: { include: { role: { select: { id: true, key: true, name: true } } } },
};

/**
 * Hooks run inside the offboarding/deactivation transaction. Later phases register side effects
 * here (stop timers, close work sessions, revoke desktop agents) without coupling modules.
 */
export const offboardingHooks = [];
/** Called inside the transaction that adds (invites) an employee: (tx, ctx, member) => Promise. */
export const employeeCreatedHooks = [];

/** Creates (and optionally emails) an invitation; earlier pending ones for the member are revoked. */
export async function sendInvitation(tx, ctx, { member, email, name, organizationName, send }, { clock, cipher, env }) {
  const token = generateToken();
  await tx.invitation.updateMany({
    where: { organizationId: ctx.orgId, userId: member.userId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: clock.now() },
  });
  const invitation = await tx.invitation.create({
    data: {
      organizationId: ctx.orgId,
      userId: member.userId,
      email,
      tokenHash: sha256(token),
      expiresAt: new Date(clock.now().getTime() + INVITE_TTL_MS),
      invitedById: ctx.userId,
      lastSentAt: clock.now(),
    },
  });
  if (send) {
    await enqueueEmail(tx, cipher, {
      to: email,
      template: 'invitation',
      organizationId: ctx.orgId,
      data: { name, organizationName, inviterName: ctx.user?.name },
      link: `${env.APP_ORIGIN}/accept-invite?token=${encodeURIComponent(token)}`,
      dedupeKey: `invitation:${invitation.id}:${sha256(token)}`,
    });
  }
  return invitation;
}

export function createEmployeeService({ prisma, env, clock, cipher, cursorCodec, sessionService }) {
  // ─── helpers ──────────────────────────────────────────────────────────────

  async function findMember(db, organizationId, employeeId) {
    const member = await db.organizationMember.findFirst({
      where: { organizationId, id: employeeId, memberType: 'EMPLOYEE' },
      include: memberInclude,
    });
    if (!member) throw new NotFoundError('Employee not found');
    return member;
  }

  function serializeBasic(m) {
    const p = m.profile;
    return {
      employeeId: m.id,
      name: m.user.name,
      email: m.user.email,
      status: m.status,
      employeeCode: p?.employeeCode ?? null,
      designation: p?.designation ?? null,
      department: p?.department ?? null,
      manager: p?.manager ? { employeeId: p.manager.id, name: p.manager.user.name } : null,
      teams: m.teamMemberships.filter((t) => !t.team.archivedAt).map((t) => ({ id: t.team.id, name: t.team.name })),
      roles: m.roles.map((r) => r.role),
      joinedAt: m.joinedAt,
      profileCompletion: p?.completionPct ?? 0,
    };
  }

  function serializeGroup(group, m) {
    const p = m.profile ?? {};
    switch (group) {
      case 'work':
        return { employmentType: p.employmentType ?? null, joiningDate: fromDate(p.joiningDate), workLocation: p.workLocation ?? null, timeZone: p.timeZone ?? null, skills: p.skills ?? null };
      case 'contact':
        return { phone: p.phone ?? null };
      case 'personal':
        return { personalEmail: cipher.decrypt(p.personalEmailEnc ?? null), address: cipher.decryptJson(p.addressEnc ?? null) };
      case 'emergency':
        return { emergencyContact: cipher.decryptJson(p.emergencyContactEnc ?? null) };
      case 'employment':
        return { probationEndDate: fromDate(p.probationEndDate), noticePeriodDays: p.noticePeriodDays ?? null, lastWorkingDate: fromDate(p.lastWorkingDate) };
      case 'security':
        return { mfaEnabled: Boolean(m.user.mfa?.enabledAt), lastLoginAt: m.user.lastLoginAt };
      default:
        return undefined;
    }
  }

  async function serializeDetail(db, ctx, m) {
    const result = serializeBasic(m);
    const readable = [];
    const editable = [];
    for (const [group, def] of Object.entries(FIELD_GROUPS)) {
      if (group !== 'basic' && (await coversMember(db, ctx, def.read, m.userId))) {
        result[group] = serializeGroup(group, m);
        readable.push(group);
      }
      if (def.update && (await canUpdateGroup(db, ctx, group, m.userId))) editable.push(group);
    }
    result.access = { readableGroups: ['basic', ...readable], editableGroups: editable };
    return result;
  }

  async function canUpdateGroup(db, ctx, group, targetUserId) {
    const def = FIELD_GROUPS[group];
    if (!def.update || !(await coversMember(db, ctx, def.update, targetUserId))) return false;
    // Self-service edits can be switched off per group in organization settings.
    if (targetUserId === ctx.userId && def.selfService && !hasOrgScope(ctx, def.update)) {
      return (ctx.orgSettings?.profile?.selfServiceFields ?? []).includes(group);
    }
    return true;
  }

  async function assertDepartment(db, organizationId, departmentId) {
    if (!departmentId) return;
    const exists = await db.department.findFirst({ where: { organizationId, id: departmentId, archivedAt: null } });
    if (!exists) throw new ValidationError([{ path: 'body.departmentId', message: 'Department not found' }]);
  }

  async function assertSeatAvailable(db, ctx) {
    const org = await db.organization.findUnique({ where: { id: ctx.orgId } });
    if (org.seatLimit === null) return;
    const used = await db.organizationMember.count({ where: { organizationId: ctx.orgId, status: { in: ['ACTIVE', 'INVITED'] } } });
    if (used >= org.seatLimit) throw new BusinessRuleError(`Your plan allows ${org.seatLimit} members`, ERROR_CODES.SEAT_LIMIT_REACHED);
  }

  const issueInvitation = (tx, ctx, args) => sendInvitation(tx, ctx, args, { clock, cipher, env });

  async function deactivateInTx(tx, ctx, member, { status, reason }) {
    if (member.userId === ctx.userId) throw new ForbiddenError('You cannot deactivate your own account');
    await tx.organizationMember.update({
      where: { organizationId_userId: { organizationId: ctx.orgId, userId: member.userId } },
      data: { status, deactivatedAt: clock.now() },
    });
    await assertOwnerRemains(tx, ctx.orgId);
    await sessionService.revoke(tx, { userId: member.userId, activeOrganizationId: ctx.orgId }, reason);
    await tx.invitation.updateMany({
      where: { organizationId: ctx.orgId, userId: member.userId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: clock.now() },
    });
    for (const hook of offboardingHooks) await hook(tx, ctx, member);
  }

  // ─── list / export ────────────────────────────────────────────────────────

  async function buildListWhere(ctx, query) {
    const where = { organizationId: ctx.orgId, memberType: 'EMPLOYEE' };
    if (!query.status.includes('ALL')) where.status = { in: query.status };

    const scope = await resolveMemberScope(prisma, ctx, 'employees.read');
    if (!scope.all) where.userId = { in: [...scope.userIds] };

    const profile = {};
    if (query.departmentId) profile.departmentId = query.departmentId;
    if (query.managerEmployeeId) {
      profile.managerUserId = (await resolveEmployeeUserId(prisma, ctx.orgId, query.managerEmployeeId, 'query.managerEmployeeId')) ?? '';
    }
    if (Object.keys(profile).length) where.profile = { is: profile };
    if (query.teamId) where.teamMemberships = { some: { teamId: query.teamId } };
    if (query.roleId) where.roles = { some: { roleId: query.roleId } };
    if (query.q) {
      const q = query.q;
      where.OR = [
        { user: { name: { contains: q } } },
        { user: { email: { contains: q } } },
        { profile: { is: { employeeCode: { contains: q } } } },
        { profile: { is: { designation: { contains: q } } } },
        { profile: { is: { phone: { contains: q } } } },
      ];
    }
    return where;
  }

  function sortSpec(sort) {
    const direction = sort.startsWith('-') ? 'desc' : 'asc';
    const field = sort.replace(/^-/, '');
    const orderBy = field === 'name' ? [{ user: { name: direction } }, { id: direction }] : [{ createdAt: direction }, { id: direction }];
    const cmp = direction === 'asc' ? 'gt' : 'lt';
    const keyset = (value, id) =>
      field === 'name'
        ? { OR: [{ user: { name: { [cmp]: value } } }, { user: { name: value }, id: { [cmp]: id } }] }
        : { OR: [{ createdAt: { [cmp]: new Date(value) } }, { createdAt: new Date(value), id: { [cmp]: id } }] };
    const valueOf = (m) => (field === 'name' ? m.user.name : m.createdAt.toISOString());
    return { orderBy, keyset, valueOf };
  }

  return {
    async list(ctx, query) {
      const where = await buildListWhere(ctx, query);
      const { orderBy, keyset, valueOf } = sortSpec(query.sort);
      if (query.cursor) {
        const c = cursorCodec.decode(query.cursor, query.sort);
        where.AND = [keyset(c.v, c.id)];
      }
      const rows = await prisma.organizationMember.findMany({ where, orderBy, take: query.limit + 1, include: memberInclude });
      const page = rows.slice(0, query.limit);
      const next = rows.length > query.limit ? page.at(-1) : null;
      return {
        items: page.map(serializeBasic),
        nextCursor: next ? cursorCodec.encode({ sort: query.sort, v: valueOf(next), id: next.id }) : null,
      };
    },

    async exportCsv(ctx, query) {
      const where = await buildListWhere(ctx, query);
      const rows = await prisma.organizationMember.findMany({
        where,
        orderBy: sortSpec(query.sort).orderBy,
        take: EXPORT_LIMIT + 1,
        include: memberInclude,
      });
      if (rows.length > EXPORT_LIMIT) {
        throw new BusinessRuleError(`Exports are limited to ${EXPORT_LIMIT} rows; narrow the filters (larger exports arrive with report jobs)`);
      }
      const includeWork = hasOrgScope(ctx, 'employees.fields.work.read');
      const includeContact = hasOrgScope(ctx, 'employees.fields.contact.read');
      const header = ['employee_id', 'name', 'email', 'status', 'employee_code', 'designation', 'department', 'manager', 'teams', 'roles'];
      if (includeWork) header.push('employment_type', 'joining_date', 'work_location', 'time_zone');
      if (includeContact) header.push('phone');
      const lines = [header];
      for (const m of rows) {
        const b = serializeBasic(m);
        const line = [b.employeeId, b.name, b.email, b.status, b.employeeCode, b.designation, b.department?.name, b.manager?.name, b.teams.map((t) => t.name).join('; '), b.roles.map((r) => r.name).join('; ')];
        if (includeWork) {
          const w = serializeGroup('work', m);
          line.push(w.employmentType, w.joiningDate, w.workLocation, w.timeZone);
        }
        if (includeContact) line.push(m.profile?.phone);
        lines.push(line);
      }
      await recordAudit(prisma, ctx, { action: 'employees.exported', targetType: 'employee', diff: { filters: query, rows: rows.length } });
      return lines.map((cols) => cols.map(csvCell).join(',')).join('\r\n') + '\r\n';
    },

    // ─── read ─────────────────────────────────────────────────────────────

    async get(ctx, employeeId) {
      const member = await findMember(prisma, ctx.orgId, employeeId);
      if (!(await coversMember(prisma, ctx, 'employees.read', member.userId))) throw new NotFoundError('Employee not found');
      return serializeDetail(prisma, ctx, member);
    },

    async history(ctx, employeeId, { cursor, limit }) {
      const member = await findMember(prisma, ctx.orgId, employeeId);
      if (!(await coversMember(prisma, ctx, 'employees.history.read', member.userId))) throw new ForbiddenError();
      const where = { organizationId: ctx.orgId, userId: member.userId };
      if (cursor) {
        const c = cursorCodec.decode(cursor, 'history');
        where.OR = [{ createdAt: { lt: new Date(c.v) } }, { createdAt: new Date(c.v), id: { lt: c.id } }];
      }
      const rows = await prisma.profileChangeHistory.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? page.at(-1) : null;
      return {
        items: page.map((h) => ({ id: h.id, field: h.field, oldValue: h.oldValue, newValue: h.newValue, changedById: h.changedById, createdAt: h.createdAt })),
        nextCursor: next ? cursorCodec.encode({ sort: 'history', v: next.createdAt.toISOString(), id: next.id }) : null,
      };
    },

    // ─── create / invite ──────────────────────────────────────────────────

    async create(ctx, input, { send = true } = {}) {
      return withTransaction(prisma, async (tx) => {
        await assertSeatAvailable(tx, ctx);
        const roleIds = input.roleIds ?? [(await tx.role.findFirst({ where: { organizationId: ctx.orgId, key: 'EMPLOYEE' } })).id];
        await assertCanAssignRoles(tx, ctx, roleIds);
        await assertDepartment(tx, ctx.orgId, input.departmentId);
        const managerUserId = await resolveEmployeeUserId(tx, ctx.orgId, input.managerEmployeeId, 'body.managerEmployeeId');
        const teams = input.teamIds.length
          ? await tx.team.findMany({ where: { organizationId: ctx.orgId, id: { in: input.teamIds }, archivedAt: null } })
          : [];
        if (teams.length !== new Set(input.teamIds).size) throw new ValidationError([{ path: 'body.teamIds', message: 'One or more teams were not found' }]);

        const user = (await tx.user.findUnique({ where: { email: input.email } })) ?? (await tx.user.create({ data: { email: input.email, name: input.name } }));
        const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: user.id } } });
        if (existing && existing.status !== 'ARCHIVED') throw new ConflictError('This person is already a member of the organization');

        const member = existing
          ? await tx.organizationMember.update({
              where: { organizationId_userId: { organizationId: ctx.orgId, userId: user.id } },
              data: { status: 'INVITED', deactivatedAt: null, joinedAt: null },
            })
          : await tx.organizationMember.create({ data: { organizationId: ctx.orgId, userId: user.id, status: 'INVITED' } });

        const profileData = withCompletion({
          employeeCode: input.employeeCode ?? null,
          designation: input.designation ?? null,
          departmentId: input.departmentId ?? null,
          managerUserId,
          employmentType: input.employmentType ?? null,
          joiningDate: toDate(input.joiningDate),
          timeZone: input.timeZone ?? null,
        });
        await tx.employeeProfile.upsert({
          where: { organizationId_userId: { organizationId: ctx.orgId, userId: user.id } },
          update: profileData,
          create: { organizationId: ctx.orgId, userId: user.id, ...profileData },
        });
        await tx.memberRole.deleteMany({ where: { organizationId: ctx.orgId, userId: user.id } });
        await tx.memberRole.createMany({ data: roleIds.map((roleId) => ({ organizationId: ctx.orgId, userId: user.id, roleId })) });
        await tx.teamMember.deleteMany({ where: { organizationId: ctx.orgId, userId: user.id } });
        if (teams.length) await tx.teamMember.createMany({ data: teams.map((t) => ({ organizationId: ctx.orgId, teamId: t.id, userId: user.id })) });

        const invitation = await issueInvitation(tx, ctx, { member, email: user.email, name: input.name, organizationName: ctx.organization.name, send });
        for (const hook of employeeCreatedHooks) await hook(tx, ctx, member);
        await recordAudit(tx, ctx, {
          action: 'employees.invited',
          targetType: 'employee',
          targetId: member.id,
          diff: { email: user.email, roleIds, rehire: Boolean(existing) },
        });
        return { employee: serializeBasic(await findMember(tx, ctx.orgId, member.id)), invitationId: invitation.id };
      });
    },

    // ─── update ───────────────────────────────────────────────────────────

    async update(ctx, employeeId, patch) {
      return withTransaction(prisma, async (tx) => {
        const member = await findMember(tx, ctx.orgId, employeeId);
        if (!(await coversMember(tx, ctx, 'employees.read', member.userId))) throw new NotFoundError('Employee not found');

        const groups = new Set(Object.keys(patch).map((field) => GROUP_OF_FIELD[field]));
        for (const group of groups) {
          if (!(await canUpdateGroup(tx, ctx, group, member.userId))) {
            const fields = Object.keys(patch).filter((f) => GROUP_OF_FIELD[f] === group);
            throw new ForbiddenError(`You cannot change: ${fields.join(', ')}`);
          }
        }

        const profile = member.profile ?? (await tx.employeeProfile.create({ data: { organizationId: ctx.orgId, userId: member.userId } }));
        const data = {};
        const changes = [];
        const note = (field, oldValue, newValue) => {
          const sensitive = FIELD_GROUPS[GROUP_OF_FIELD[field]].sensitive;
          const fmt = (v) => (v === null || v === undefined ? null : sensitive ? REDACTED : typeof v === 'string' ? v : JSON.stringify(v));
          if (JSON.stringify(oldValue ?? null) !== JSON.stringify(newValue ?? null)) changes.push({ field, oldValue: fmt(oldValue), newValue: fmt(newValue) });
        };

        for (const [field, value] of Object.entries(patch)) {
          switch (field) {
            case 'name':
              note(field, member.user.name, value);
              break;
            case 'departmentId':
              await assertDepartment(tx, ctx.orgId, value);
              note(field, profile.departmentId, value);
              data.departmentId = value;
              break;
            case 'managerEmployeeId': {
              const managerUserId = await resolveEmployeeUserId(tx, ctx.orgId, value, 'body.managerEmployeeId');
              await assertNoReportingCycle(tx, ctx.orgId, member.userId, managerUserId);
              note(field, member.profile?.manager?.id ?? null, value);
              data.managerUserId = managerUserId;
              break;
            }
            case 'joiningDate':
            case 'probationEndDate':
            case 'lastWorkingDate':
              note(field, fromDate(profile[field]), value);
              data[field] = toDate(value);
              break;
            case 'personalEmail':
              note(field, cipher.decrypt(profile.personalEmailEnc), value);
              data.personalEmailEnc = cipher.encrypt(value);
              break;
            case 'address':
            case 'emergencyContact':
              note(field, cipher.decryptJson(profile[`${field}Enc`]), value);
              data[`${field}Enc`] = cipher.encryptJson(value);
              break;
            default:
              note(field, profile[field], value);
              data[field] = value;
          }
        }

        if ('name' in patch) await tx.user.update({ where: { id: member.userId }, data: { name: patch.name } });
        const merged = { ...profile, ...data };
        data.completionPct = profileCompletion(merged);
        await tx.employeeProfile.update({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: member.userId } }, data });

        if (changes.length) {
          await tx.profileChangeHistory.createMany({
            data: changes.map((c) => ({ organizationId: ctx.orgId, userId: member.userId, ...c, changedById: ctx.userId, requestId: ctx.requestId })),
          });
          await recordAudit(tx, ctx, { action: 'employees.updated', targetType: 'employee', targetId: member.id, diff: { fields: changes.map((c) => c.field) } });
          if (member.userId !== ctx.userId) {
            // Field names only: the notification (and its email) never carries the values.
            await notify(tx, ctx, {
              cipher,
              appOrigin: env.APP_ORIGIN,
              organizationId: ctx.orgId,
              recipientUserId: member.userId,
              type: 'employees.profile_changed',
              title: `${ctx.user?.name ?? 'An administrator'} updated your profile`,
              body: `Changed: ${changes.map((c) => c.field).join(', ')}`,
              link: `/employees/${member.id}/profile`,
              subjectType: 'employee',
              subjectId: member.id,
              dedupeKey: `profile:${ctx.requestId}`,
            });
          }
        }
        return serializeDetail(tx, ctx, await findMember(tx, ctx.orgId, employeeId));
      });
    },

    // ─── lifecycle ────────────────────────────────────────────────────────

    async activate(ctx, employeeId) {
      return withTransaction(prisma, async (tx) => {
        const member = await findMember(tx, ctx.orgId, employeeId);
        if (!['DEACTIVATED', 'SUSPENDED'].includes(member.status)) {
          throw new ConflictError(`Cannot activate an employee who is ${member.status.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
        }
        await assertSeatAvailable(tx, ctx);
        await tx.organizationMember.update({
          where: { organizationId_userId: { organizationId: ctx.orgId, userId: member.userId } },
          data: { status: 'ACTIVE', deactivatedAt: null },
        });
        await recordAudit(tx, ctx, { action: 'employees.activated', targetType: 'employee', targetId: member.id });
        return serializeBasic(await findMember(tx, ctx.orgId, employeeId));
      });
    },

    async deactivate(ctx, employeeId) {
      return withTransaction(prisma, async (tx) => {
        const member = await findMember(tx, ctx.orgId, employeeId);
        if (member.status !== 'ACTIVE') {
          throw new ConflictError(`Cannot deactivate an employee who is ${member.status.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
        }
        await deactivateInTx(tx, ctx, member, { status: 'DEACTIVATED', reason: 'member_deactivated' });
        await recordAudit(tx, ctx, { action: 'employees.deactivated', targetType: 'employee', targetId: member.id });
        return serializeBasic(await findMember(tx, ctx.orgId, employeeId));
      });
    },

    async offboard(ctx, employeeId, { lastWorkingDate, reason }) {
      return withTransaction(prisma, async (tx) => {
        const member = await findMember(tx, ctx.orgId, employeeId);
        if (!['ACTIVE', 'SUSPENDED', 'INVITED'].includes(member.status)) {
          throw new ConflictError(`Cannot offboard an employee who is ${member.status.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
        }
        await tx.employeeProfile.updateMany({ where: { organizationId: ctx.orgId, userId: member.userId }, data: { lastWorkingDate: toDate(lastWorkingDate) } });
        await deactivateInTx(tx, ctx, member, { status: 'DEACTIVATED', reason: 'member_offboarded' });
        await tx.profileChangeHistory.create({
          data: { organizationId: ctx.orgId, userId: member.userId, field: 'lastWorkingDate', oldValue: fromDate(member.profile?.lastWorkingDate), newValue: lastWorkingDate, changedById: ctx.userId, requestId: ctx.requestId },
        });
        await recordAudit(tx, ctx, { action: 'employees.offboarded', targetType: 'employee', targetId: member.id, diff: { lastWorkingDate, reason } });
        return serializeBasic(await findMember(tx, ctx.orgId, employeeId));
      });
    },

    async archive(ctx, employeeId) {
      await withTransaction(prisma, async (tx) => {
        const member = await findMember(tx, ctx.orgId, employeeId);
        if (member.status === 'ARCHIVED') return;
        if (!['DEACTIVATED', 'INVITED'].includes(member.status)) {
          throw new ConflictError('Deactivate or offboard the employee before archiving', ERROR_CODES.INVALID_STATE_TRANSITION);
        }
        if (member.status === 'INVITED') await deactivateInTx(tx, ctx, member, { status: 'ARCHIVED', reason: 'member_archived' });
        else await tx.organizationMember.update({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: member.userId } }, data: { status: 'ARCHIVED' } });
        await recordAudit(tx, ctx, { action: 'employees.archived', targetType: 'employee', targetId: member.id });
      });
    },

    // ─── invitations ──────────────────────────────────────────────────────

    async listInvitations(ctx) {
      const rows = await prisma.invitation.findMany({
        where: { organizationId: ctx.orgId, acceptedAt: null, revokedAt: null },
        include: { member: { select: { id: true, user: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const now = clock.now();
      return rows.map((i) => ({
        id: i.id,
        employeeId: i.member.id,
        name: i.member.user.name,
        email: i.email,
        expiresAt: i.expiresAt,
        expired: i.expiresAt <= now,
        sendCount: i.sendCount,
        lastSentAt: i.lastSentAt,
        createdAt: i.createdAt,
      }));
    },

    async resendInvitation(ctx, invitationId) {
      return withTransaction(prisma, async (tx) => {
        const invitation = await tx.invitation.findFirst({
          where: { organizationId: ctx.orgId, id: invitationId, acceptedAt: null, revokedAt: null },
          include: { member: { include: { user: true } } },
        });
        if (!invitation) throw new NotFoundError('Invitation not found');
        if (clock.now().getTime() - invitation.lastSentAt.getTime() < 60_000) {
          throw new ConflictError('This invitation was sent less than a minute ago');
        }
        const fresh = await issueInvitation(tx, ctx, {
          member: invitation.member,
          email: invitation.email,
          name: invitation.member.user.name,
          organizationName: ctx.organization.name,
          send: true,
        });
        await tx.invitation.updateMany({ where: { organizationId: ctx.orgId, id: fresh.id }, data: { sendCount: invitation.sendCount + 1 } });
        await recordAudit(tx, ctx, { action: 'employees.invitation_resent', targetType: 'invitation', targetId: fresh.id });
        return { id: fresh.id, expiresAt: fresh.expiresAt };
      });
    },

    async revokeInvitation(ctx, invitationId) {
      await withTransaction(prisma, async (tx) => {
        const invitation = await tx.invitation.findFirst({ where: { organizationId: ctx.orgId, id: invitationId, acceptedAt: null, revokedAt: null } });
        if (!invitation) throw new NotFoundError('Invitation not found');
        await tx.invitation.updateMany({ where: { organizationId: ctx.orgId, id: invitationId }, data: { revokedAt: clock.now() } });
        await tx.organizationMember.updateMany({
          where: { organizationId: ctx.orgId, userId: invitation.userId, status: 'INVITED' },
          data: { status: 'ARCHIVED' },
        });
        await recordAudit(tx, ctx, { action: 'employees.invitation_revoked', targetType: 'invitation', targetId: invitationId });
      });
    },
  };
}

/** Walks up the proposed manager's chain; meeting the employee again would create a cycle. */
async function assertNoReportingCycle(db, organizationId, employeeUserId, managerUserId) {
  const seen = new Set();
  for (let cursor = managerUserId; cursor && !seen.has(cursor); ) {
    if (cursor === employeeUserId) {
      throw new ValidationError([{ path: 'body.managerEmployeeId', message: 'This would create a reporting cycle' }]);
    }
    seen.add(cursor);
    const profile = await db.employeeProfile.findUnique({
      where: { organizationId_userId: { organizationId, userId: cursor } },
      select: { managerUserId: true },
    });
    cursor = profile?.managerUserId;
  }
}

