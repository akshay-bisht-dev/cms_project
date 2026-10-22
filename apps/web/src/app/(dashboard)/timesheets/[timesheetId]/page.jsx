import { TimesheetDetail } from '@/features/timesheets/timesheet-detail';

export const metadata = { title: 'Timesheet' };

export default async function Page({ params }) {
  const { timesheetId } = await params;
  return <TimesheetDetail timesheetId={timesheetId} />;
}
