import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectAccessible, signIn, signOut, users } from './helpers.js';

const API = 'http://localhost:4100/api/v1/monitoring/agent';

/** Plays the desktop app's part: pair with the code shown on screen, then report in. */
async function connectAgent(code) {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const registered = await fetch(`${API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode: code, publicKey: raw, deviceName: 'E2E MacBook', os: 'darwin', agentVersion: '0.1.0' }),
  });
  expect(registered.status).toBe(201);
  const { data } = await registered.json();
  const heartbeat = await fetch(`${API}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.accessToken}` },
    body: JSON.stringify({ state: 'PAUSED', queueDepth: 0, queueBytes: 0, osPermission: 'granted' }),
  });
  expect(heartbeat.status).toBe(200);
  return (await heartbeat.json()).data;
}

test.describe.serial('screenshot monitoring', () => {
  test('an owner turns monitoring on and publishes a policy', async ({ page }) => {
    await signIn(page, users.owner);
    await page.goto('/settings/monitoring');
    await expect(page.getByRole('heading', { name: 'Screenshot monitoring' })).toBeVisible();
    const toggle = page.getByRole('switch', { name: 'Screenshot monitoring' });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Turn on' }).click();
    await expect(toggle).toBeChecked();

    await page.getByRole('button', { name: 'Edit settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Take screenshots').check();
    await dialog.getByLabel('Interval (minutes)').fill('5');
    await dialog.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('New version published')).toBeVisible();
    await expect(page.getByText(/Captures every 5 min/)).toBeVisible();
    await expectAccessible(page);
  });

  test('an employee reads the notice, acknowledges it and connects the desktop app', async ({ page }) => {
    await signIn(page, users.dev);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My Monitoring' }).click();
    await expect(page.getByText('Acknowledgement needed')).toBeVisible();
    await expect(page.getByText('every 5 min, at a random moment within each interval')).toBeVisible();
    await expect(page.getByText('Organization Owner')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'I have read this notice' }).click();
    await expect(page.getByText('Acknowledged', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Acknowledged' })).toHaveCount(1);
    await expect(page.getByText('Screenshots are taken while you are clocked in and working')).toBeVisible();

    await page.getByRole('button', { name: 'Connect desktop app' }).click();
    const code = await page.getByRole('dialog').getByText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/).textContent();
    const permit = await connectAgent(code);
    expect(permit).toMatchObject({ capture: false, reason: 'CLOCKED_OUT', consent: 'ACKNOWLEDGED', intervalS: 300 });
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();

    await page.reload();
    await expect(page.getByText('E2E MacBook')).toBeVisible();
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  });

  test('the timeline explains hours without captures', async ({ page }) => {
    await signIn(page, users.dev);
    await page.getByRole('banner').getByRole('button', { name: 'Clock in' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clock in' }).click();
    await expect(page.getByText('Clocked in', { exact: true }).first()).toBeVisible();

    await page.goto('/screenshots');
    await expect(page.getByRole('heading', { name: 'Screenshots' })).toBeVisible();
    // The employee sees only their own captures, so there is no person picker.
    await expect(page.getByLabel('Person')).toHaveCount(0);
    await expect(page.getByText('No captures: the desktop app was offline or paused')).toBeVisible();
    await expect(page.getByText(/0 captured · 0 missing · every 5 min/)).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('banner').getByRole('button', { name: 'Time tracking: clocked in' }).click();
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Clock in' })).toBeVisible();
  });

  test('a manager sees the employee’s day and devices; the employee disconnects the device', async ({ page }) => {
    await signIn(page, users.owner);
    await page.goto('/screenshots');
    await page.getByLabel('Person').selectOption({ label: users.dev.name });
    await expect(page.getByText('No captures: the desktop app was offline or paused')).toBeVisible();
    await page.goto('/settings/monitoring');
    await expect(page.getByText(`E2E MacBook · ${users.dev.name}`)).toBeVisible();
    await signOut(page, users.owner);

    await signIn(page, users.dev);
    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByText('Device disconnected')).toBeVisible();
    await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
  });
});
