import { expect, test } from '@playwright/test';
import { expectAccessible, signIn, signOut, users } from './helpers.js';

test('redirects signed-out visitors to the sign-in page', async ({ page }) => {
  await page.goto('/employees');
  await expect(page).toHaveURL(/\/login$/);
  await expectAccessible(page);
});

test('shows a generic error for a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(users.owner.email);
  await page.getByLabel('Password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Next.js adds its own role=alert route announcer, so match our message specifically.
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password.' })).toBeVisible();
});

test('signs in, shows the shell, and signs out', async ({ page }) => {
  await signIn(page, users.owner);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'People' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Time Off' })).toHaveAttribute('href', '/leave');
  await expect(nav.getByRole('link', { name: 'Audit Logs' })).toHaveAttribute('href', '/audit-logs');
  await expectAccessible(page);
  await signOut(page, users.owner);
  await page.goto('/my-dashboard');
  await expect(page).toHaveURL(/\/login$/);
});

test('pages carry a per-request nonce CSP and security headers', async ({ request }) => {
  const nonceOf = (csp) => /'nonce-([^']+)'/.exec(csp)?.[1];
  const first = await request.get('/login');
  const second = await request.get('/login');
  const csp = first.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-eval');
  expect(nonceOf(csp)).toBeTruthy();
  expect(nonceOf(second.headers()['content-security-policy'])).not.toBe(nonceOf(csp));
  // Next.js stamped the nonce on its scripts.
  expect(await first.text()).toContain(`nonce="${nonceOf(csp)}"`);
  const headers = first.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['x-powered-by']).toBeUndefined();
});
