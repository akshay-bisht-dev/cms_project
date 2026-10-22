import { dateOnly, localDate, secondsBetween } from '../../utils/time.js';
import { memberCalendar, scheduleSnapshot } from './schedule.js';

/** Gets or creates the attendance record for the member's local work date of `at`. */
export async function recordForInstant(tx, organizationId, userId, at) {
  const { zone, schedule } = await memberCalendar(tx, organizationId, userId);
  const workDate = localDate(at, zone);
  const where = { organizationId_userId_workDate: { organizationId, userId, workDate: dateOnly(workDate) } };
  const existing = await tx.attendanceRecord.findUnique({ where });
  if (existing) {
    if (existing.status !== 'PRESENT') {
      return tx.attendanceRecord.update({ where, data: { status: 'PRESENT' } });
    }
    return existing;
  }
  return tx.attendanceRecord.create({
    data: {
      organizationId,
      userId,
      workDate: dateOnly(workDate),
      timeZone: zone,
      flags: [],
      scheduleSnapshot: scheduleSnapshot(schedule, workDate, zone) ?? undefined,
    },
  });
}

/**
 * Recomputes a record's summary from its sessions (closed time only; open sessions are added
 * live when read). Late/early/overtime compare against the schedule snapshot plus the org grace.
 */
export async function recomputeRecord(tx, organizationId, recordId, settings) {
  const record = await tx.attendanceRecord.findFirst({ where: { organizationId, id: recordId } });
  const sessions = await tx.workSession.findMany({
    where: { organizationId, attendanceRecordId: recordId },
    include: { breaks: true },
    orderBy: { startedAt: 'asc' },
  });

  let workedS = 0;
  let breakS = 0;
  for (const s of sessions) {
    if (!s.endedAt) continue;
    const sessionBreakS = s.breaks.reduce((sum, b) => sum + (b.endedAt ? secondsBetween(b.startedAt, b.endedAt) : 0), 0);
    breakS += sessionBreakS;
    workedS += Math.max(0, secondsBetween(s.startedAt, s.endedAt) - sessionBreakS);
  }
  const open = sessions.some((s) => !s.endedAt);
  const firstInAt = sessions[0]?.startedAt ?? null;
  const lastOutAt = !open && sessions.length ? sessions.reduce((max, s) => (s.endedAt > max ? s.endedAt : max), sessions[0].endedAt) : null;

  const window = record.scheduleSnapshot?.window;
  const graceLateS = (settings?.graceLateMinutes ?? 0) * 60;
  const graceEarlyS = (settings?.graceEarlyMinutes ?? 0) * 60;
  let lateByS = 0;
  let earlyByS = 0;
  let overtimeS = 0;
  if (window && firstInAt) {
    const late = secondsBetween(new Date(window.start), firstInAt);
    lateByS = late > graceLateS ? late : 0;
  }
  if (window && lastOutAt) {
    const early = secondsBetween(lastOutAt, new Date(window.end));
    earlyByS = early > graceEarlyS ? early : 0;
  }
  if (window && !open) overtimeS = Math.max(0, workedS - window.expectedS);

  const flags = new Set((record.flags ?? []).filter((f) => f === 'CORRECTED'));
  if (lateByS) flags.add('LATE');
  if (earlyByS) flags.add('EARLY_LEAVE');
  if (sessions.some((s) => s.endReason === 'AUTO_CLOSED')) flags.add('MISSED_CLOCK_OUT');

  return tx.attendanceRecord.update({
    where: { organizationId_userId_workDate: { organizationId, userId: record.userId, workDate: record.workDate } },
    data: {
      status: sessions.length ? 'PRESENT' : record.status,
      firstInAt,
      lastOutAt,
      workedS,
      breakS,
      lateByS,
      earlyByS,
      overtimeS,
      flags: [...flags],
    },
  });
}
