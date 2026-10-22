'use client';

import { KeyRound, UserX } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/common/states';
import { useEmployee } from '../queries';
import { ActivityTab } from './activity-tab';
import { OverviewTab } from './overview-tab';
import { ProfileHeader } from './profile-header';
import { ProfileTab } from './profile-tab';
import { ProfileTabs } from './profile-tabs';
import { AttendanceMonth } from '@/features/attendance/attendance-page';
import { EmployeeTimesheets } from '@/features/timesheets/timesheets-page';
import { TimeEntriesWeek } from '@/features/time/time-page';
import { EmployeeProjects, EmployeeTasks } from './work-tabs';
import { EmployeeScreenshots } from '@/features/monitoring/screenshot-timeline';
import { EmployeeAppSettings } from '@/features/monitoring/employee-monitoring';
import { PersonActivity } from '@/features/activity/activity-page';
import { EmployeeLeave } from '@/features/leave/leave-page';
import { EmployeeChecklists, EmployeeDocuments } from '@/features/hr/hr-pages';
import { ApiKeys } from '@/features/integrations/integrations';
import { CustomFieldsCard } from '@/features/custom-fields/custom-fields';
import { useMe } from '@/features/session/session-provider';

const TAB_COMPONENTS = {
  dashboard: OverviewTab,
  profile: ({ employee }) => (
    <div className="grid gap-6">
      <ProfileTab employee={employee} />
      <CustomFieldsCard entity="EMPLOYEE" entityId={employee.employeeId} />
    </div>
  ),
  'time-off': ({ employee }) => <SelfAware employee={employee} render={(self) => <EmployeeLeave employeeId={employee.employeeId} self={self} />} />,
  documents: ({ employee }) => (
    <div className="grid gap-6">
      <EmployeeDocuments employeeId={employee.employeeId} />
      <EmployeeChecklists employeeId={employee.employeeId} />
    </div>
  ),
  integrations: ({ employee }) => (
    <SelfAware
      employee={employee}
      render={(self) => (self ? <ApiKeys mine /> : <EmptyState icon={KeyRound} title="API keys are personal" description="Each person sees their own keys here. Organization-wide keys are under Settings → Integrations." />)}
    />
  ),
  // Recorded work activity, then the history of changes to the profile itself.
  activity: ({ employee }) => (
    <div className="grid gap-6">
      <PersonActivity employeeId={employee.employeeId} />
      <ActivityTab employee={employee} />
    </div>
  ),
  projects: ({ employee }) => <EmployeeProjects employeeId={employee.employeeId} />,
  tasks: ({ employee }) => <EmployeeTasks employeeId={employee.employeeId} />,
  attendance: ({ employee }) => <AttendanceMonth employeeId={employee.employeeId} />,
  screenshots: ({ employee }) => <EmployeeScreenshots employeeId={employee.employeeId} />,
  'app-settings': ({ employee }) => <EmployeeAppSettings employeeId={employee.employeeId} />,
  timesheets: ({ employee }) => (
    <div className="grid gap-6">
      <TimeEntriesWeek employeeId={employee.employeeId} />
      <EmployeeTimesheets employeeId={employee.employeeId} />
    </div>
  ),
};

function SelfAware({ employee, render }) {
  const me = useMe();
  return render(employee.employeeId === me.employeeId);
}

export function EmployeeProfile({ employeeId, tab }) {
  const employee = useEmployee(employeeId);

  if (employee.isPending) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading profile">
        <Skeleton className="h-32" />
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (employee.error) {
    return employee.error.status === 404 || employee.error.status === 400 ? (
      <EmptyState icon={UserX} title="Employee not found" description="They may have been archived, or you may not have access." />
    ) : (
      <ErrorState error={employee.error} onRetry={() => employee.refetch()} />
    );
  }

  const Tab = TAB_COMPONENTS[tab];
  return (
    <>
      <ProfileHeader employee={employee.data} />
      <ProfileTabs employeeId={employeeId} active={tab} />
      <Tab employee={employee.data} />
    </>
  );
}
