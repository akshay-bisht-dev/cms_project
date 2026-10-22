import { Prisma } from '@prisma/client';
import { dateOnly, isoDate, localDate } from '../../utils/time.js';
import { ensureLeaveSetup, ledgerBalance, resolveLeavePolicy } from './leave.service.js';

const D = Prisma.Decimal;

async function credit(db, data) {
  try {
    await db.leaveLedgerEntry.create({ data });
    return true;
  } catch (err) {
    if (err?.code === 'P2002') return false; // already credited for this period
    throw err;
  }
}

/**
 * Accrues leave for every active employee (FR-LV-1). Monthly policies credit once per month,
 * annual policies once per year; each credit has an idempotency key for its period, so the job
 * can run daily (or catch up after downtime) without double-crediting. A cap limits the balance.
 * New joiners accrue from the period they joined in.
 */
export async function runAccruals({ prisma, clock, logger }) {
  const orgs = await prisma.organization.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true, timeZone: true } });
  let credited = 0;
  for (const org of orgs) {
    await ensureLeaveSetup(prisma, org.id);
    const today = localDate(clock.now(), org.timeZone);
    const [year, month] = today.split('-');
    const [types, members] = await Promise.all([
      prisma.leaveType.findMany({ where: { organizationId: org.id, archivedAt: null } }),
      prisma.organizationMember.findMany({ where: { organizationId: org.id, status: 'ACTIVE', memberType: 'EMPLOYEE' }, select: { userId: true, joinedAt: true } }),
    ]);
    for (const member of members) {
      const joined = member.joinedAt ? localDate(member.joinedAt, org.timeZone) : null;
      for (const type of types) {
        const policy = await resolveLeavePolicy(prisma, org.id, member.userId, type.id);
        if (!policy || policy.accrual === 'NONE' || new D(policy.accrualDays).lte(0)) continue;
        const period = policy.accrual === 'MONTHLY' ? `${year}-${month}` : year;
        const periodStart = policy.accrual === 'MONTHLY' ? `${year}-${month}-01` : `${year}-01-01`;
        if (joined && joined > today) continue;
        let amount = new D(policy.accrualDays);
        if (policy.capDays !== null) {
          const balance = await ledgerBalance(prisma, org.id, member.userId, type.id, Number(year));
          amount = D.min(amount, new D(policy.capDays).minus(balance));
          if (amount.lte(0)) continue;
        }
        const ok = await credit(prisma, {
          organizationId: org.id,
          userId: member.userId,
          leaveTypeId: type.id,
          entryType: 'ACCRUAL',
          days: amount,
          effectiveDate: dateOnly(joined && joined > periodStart ? joined : periodStart),
          note: `${policy.accrual === 'MONTHLY' ? 'Monthly' : 'Annual'} accrual (${policy.name})`,
          idempotencyKey: `accrual:${type.id}:${member.userId}:${period}`,
        });
        if (ok) credited += 1;
      }
    }
  }
  logger?.info({ credited }, 'leave accruals run');
  return { credited };
}

/**
 * Carries unused leave into the new year, up to the policy's carry-over maximum (none when the
 * policy sets no maximum). Idempotent per member, type and year.
 */
export async function runCarryOver({ prisma, clock, logger }) {
  const orgs = await prisma.organization.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true, timeZone: true } });
  let carried = 0;
  for (const org of orgs) {
    const year = Number(localDate(clock.now(), org.timeZone).slice(0, 4));
    const [types, members] = await Promise.all([
      prisma.leaveType.findMany({ where: { organizationId: org.id, archivedAt: null } }),
      prisma.organizationMember.findMany({ where: { organizationId: org.id, status: 'ACTIVE', memberType: 'EMPLOYEE' }, select: { userId: true } }),
    ]);
    for (const member of members) {
      for (const type of types) {
        const policy = await resolveLeavePolicy(prisma, org.id, member.userId, type.id);
        if (!policy || policy.carryOverMaxDays === null) continue;
        const previous = await ledgerBalance(prisma, org.id, member.userId, type.id, year - 1);
        const amount = D.min(previous, new D(policy.carryOverMaxDays));
        if (amount.lte(0)) continue;
        const ok = await credit(prisma, {
          organizationId: org.id,
          userId: member.userId,
          leaveTypeId: type.id,
          entryType: 'CARRY_OVER',
          days: amount,
          effectiveDate: dateOnly(`${year}-01-01`),
          note: `Carried over from ${year - 1} (max ${new D(policy.carryOverMaxDays).toFixed(2)})`,
          idempotencyKey: `carry:${type.id}:${member.userId}:${year}`,
        });
        if (ok) carried += 1;
      }
    }
  }
  logger?.info({ carried }, 'leave carry-over run');
  return { carried };
}

/** Approved leave per date for a member: { 'YYYY-MM-DD': halves (1 or 2) }. */
export async function approvedLeaveHalves(db, organizationId, userId, from, to) {
  const { halvesByDate } = await import('./leave-days.js');
  const rows = await db.leaveRequest.findMany({ where: { organizationId, userId, status: 'APPROVED', startDate: { lte: dateOnly(to) }, endDate: { gte: dateOnly(from) } } });
  const out = new Map();
  for (const r of rows) {
    for (const [date, n] of halvesByDate({ startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), startHalf: r.startHalf, endHalf: r.endHalf })) {
      if (date >= from && date <= to) out.set(date, Math.min(2, (out.get(date) ?? 0) + n));
    }
  }
  return out;
}
