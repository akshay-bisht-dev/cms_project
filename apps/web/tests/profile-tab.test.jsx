import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfileTab } from '@/features/employees/profile/profile-tab';

const base = {
  employeeId: 'e1',
  name: 'Dev Patel',
  employeeCode: 'E-1',
  designation: 'Engineer',
  department: { id: 'd1', name: 'Engineering' },
  manager: null,
  work: { employmentType: 'FULL_TIME', joiningDate: null, workLocation: null, timeZone: null, skills: ['Go', 'SQL'] },
  contact: { phone: '+1 555 0100' },
  personal: { personalEmail: 'home@example.test', address: null },
};

function renderTab(employee) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProfileTab employee={employee} />
    </QueryClientProvider>,
  );
}

describe('ProfileTab', () => {
  it('renders only the groups the API marked readable, with edit buttons only where editable', () => {
    renderTab({ ...base, access: { readableGroups: ['basic', 'work', 'contact'], editableGroups: ['contact'] } });
    expect(screen.getByRole('heading', { name: 'Basic information' })).toBeInTheDocument();
    expect(screen.getByText('Full-time')).toBeInTheDocument();
    expect(screen.getByText('Go, SQL')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Personal details' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit contact' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit basic information' })).toBeNull();
  });

  it('labels sensitive groups and shows "Not set" for empty values', () => {
    renderTab({ ...base, access: { readableGroups: ['basic', 'work', 'personal'], editableGroups: [] } });
    expect(screen.getAllByText('Visible only to the employee and authorized HR roles')).toHaveLength(1);
    expect(screen.getByText('home@example.test')).toBeInTheDocument();
    expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('—')).toBeNull();
  });
});
