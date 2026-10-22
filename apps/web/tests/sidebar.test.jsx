import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionProvider } from '@/features/session/session-provider';
import { Sidebar } from '@/components/layout/sidebar';

vi.mock('next/navigation', () => ({ usePathname: () => '/employees/123/profile' }));

function renderSidebar(permissions) {
  const me = { user: { name: 'Test' }, organization: { id: 'o' }, organizations: [], permissions: permissions.map((key) => ({ key, scopes: ['org'] })) };
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider initialMe={me}>
        <TooltipProvider>
          <Sidebar />
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('Sidebar', () => {
  it('hides items the user has no permission for', () => {
    renderSidebar([]);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'My Dashboard' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'People' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('shows permitted items and marks the active section', () => {
    renderSidebar(['employees.read', 'org.settings.read', 'dashboard.read', 'leave.self']);
    const people = screen.getByRole('link', { name: 'People' });
    expect(people).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/organization');
    expect(screen.getByRole('link', { name: 'Time Off' })).toHaveAttribute('href', '/leave');
    expect(screen.queryByRole('link', { name: 'Audit Logs' })).toBeNull();
    expect(screen.queryByRole('link', { name: /available in Phase/ })).toBeNull();
  });
});
