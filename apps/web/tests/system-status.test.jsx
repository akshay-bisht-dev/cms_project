import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemStatus } from '@/features/system/system-status';

function renderWithClient(ui) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function mockFetch(status, body) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
}

afterEach(() => vi.unstubAllGlobals());

describe('SystemStatus', () => {
  it('shows every dependency as operational when the API is ready', async () => {
    mockFetch(200, {
      success: true,
      data: { status: 'ready', checks: { database: { status: 'up' }, redis: { status: 'up' }, storage: { status: 'up' } } },
      meta: {},
    });
    renderWithClient(<SystemStatus />);
    expect(await screen.findAllByText('Operational')).toHaveLength(3);
  });

  it('marks only the failing dependency as unavailable on a 503', async () => {
    mockFetch(503, {
      success: false,
      error: { code: 'UNAVAILABLE', message: 'One or more dependencies are unavailable', details: [{ path: 'redis', message: 'unavailable' }] },
      requestId: 'req-1',
    });
    renderWithClient(<SystemStatus />);
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('Operational')).toHaveLength(2);
  });

  it('shows an error with the request id when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    renderWithClient(<SystemStatus />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The API could not be reached');
  });
});
