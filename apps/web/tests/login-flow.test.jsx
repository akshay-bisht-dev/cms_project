import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginFlow } from '@/features/auth/login-flow';

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
  useSearchParams: () => search,
}));

function respond(sequence) {
  const fetchMock = vi.fn(async () => {
    const [status, body] = sequence.shift();
    // A 204 response must not carry a body.
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function submit(email = 'a@b.test', password = 'secret-password') {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
  search = new URLSearchParams();
});

describe('LoginFlow', () => {
  it('shows a friendly message for invalid credentials', async () => {
    respond([[401, { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'x', details: [] } }]]);
    render(<LoginFlow />);
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(replace).not.toHaveBeenCalled();
  });

  it('moves to the two-factor step, then to the organization picker', async () => {
    respond([
      [200, { success: true, data: { status: 'MFA_REQUIRED', organizations: [] }, meta: {} }],
      [204, null],
      [200, { success: true, data: { organization: null, organizations: [{ id: 'o1', name: 'First' }, { id: 'o2', name: 'Second' }] }, meta: {} }],
    ]);
    render(<LoginFlow />);
    await submit();
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('heading', { name: 'Choose an organization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Second/ })).toBeInTheDocument();
  });

  it('only follows same-site redirect targets after sign-in', async () => {
    search = new URLSearchParams({ next: '//evil.example/phish' });
    respond([[200, { success: true, data: { status: 'AUTHENTICATED', organizations: [] }, meta: {} }]]);
    render(<LoginFlow />);
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/my-dashboard'));
  });
});
