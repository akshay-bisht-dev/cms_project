import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatRelative } from '@/lib/format';

function Row({ label, children }) {
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children ?? '—'}</dd>
    </div>
  );
}

export function OverviewTab({ employee }) {
  const completion = employee.profileCompletion;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Row label="Department">{employee.department?.name}</Row>
            <Row label="Manager">
              {employee.manager ? (
                <Link className="text-primary hover:underline" href={`/employees/${employee.manager.employeeId}`}>
                  {employee.manager.name}
                </Link>
              ) : null}
            </Row>
            <Row label="Teams">{employee.teams.map((t) => t.name).join(', ') || null}</Row>
            <Row label="Roles">{employee.roles.map((r) => r.name).join(', ')}</Row>
            <Row label="Joined">{employee.joinedAt ? formatDate(employee.joinedAt) : employee.status === 'INVITED' ? 'Invitation pending' : null}</Row>
          </dl>
        </CardContent>
      </Card>
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Profile completion</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{completion}%</p>
            <div
              className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Profile completion"
              aria-valuenow={completion}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${completion}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Share of the 12 standard profile fields that are filled in.</p>
          </CardContent>
        </Card>
        {employee.security && (
          <Card>
            <CardHeader>
              <CardTitle>Account security</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <Row label="Two-factor">{employee.security.mfaEnabled ? 'On' : 'Off'}</Row>
                <Row label="Last sign-in">{employee.security.lastLoginAt ? formatRelative(employee.security.lastLoginAt) : 'Never'}</Row>
              </dl>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
