import { expect, test } from '@playwright/test';
import { expectAccessible, signIn, users } from './helpers.js';

/** A Wednesday two to three weeks out: a working day for every seeded schedule. */
function leaveDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 14 + ((3 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

test.describe.serial('leave, HR and integrations', () => {
  const day = leaveDate();

  test('an employee requests a day off with a live balance preview', async ({ page }) => {
    await signIn(page, users.dev);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Time Off' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Time off' })).toBeVisible();
    await expect(page.getByText('Annual Leave', { exact: false }).first()).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Request leave' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('From').fill(day);
    await dialog.getByLabel('To').fill(day);
    await dialog.getByLabel('Note for your approver').fill('Family event');
    await expect(dialog.getByRole('status')).toContainText('1 day');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Request' }).click();
    await expect(page.getByText('Leave requested')).toBeVisible();
    await expect(page.getByRole('table', { name: 'My leave requests' }).getByText('Pending')).toBeVisible();
  });

  test('the manager, then HR, approve it', async ({ page }) => {
    await signIn(page, users.lead);
    await page.goto('/leave?view=approvals');
    const table = page.getByRole('table', { name: 'Leave to approve' });
    await expect(table.getByText(users.dev.name)).toBeVisible();
    await expectAccessible(page);
    await table.getByRole('button', { name: 'Approve' }).first().click();
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();

    await page.context().clearCookies();
    await signIn(page, users.hr);
    await page.goto('/leave?view=approvals');
    const hrTable = page.getByRole('table', { name: 'Leave to approve' });
    await expect(hrTable.getByText(users.dev.name)).toBeVisible();
    await hrTable.getByRole('button', { name: 'Approve' }).first().click();
    await expect(hrTable.getByText(users.dev.name)).toHaveCount(0);
  });

  test('the employee sees the approval on their profile', async ({ page }) => {
    await signIn(page, users.dev);
    await page.goto('/leave');
    await expect(page.getByRole('table', { name: 'My leave requests' }).getByText('Approved')).toBeVisible();
  });

  test('HR configures leave policies and a custom field, then fills it in on a profile', async ({ page }) => {
    await signIn(page, users.owner);
    await page.goto('/settings/leave');
    await expect(page.getByRole('heading', { level: 1, name: 'Leave' })).toBeVisible();
    await expectAccessible(page);

    await page.goto('/settings/custom-fields');
    await page.getByLabel('Record type').selectOption('EMPLOYEE');
    await page.getByRole('textbox', { name: /^Label/ }).fill('T-shirt size');
    await page.getByLabel('Type', { exact: true }).selectOption('SELECT');
    await page.getByLabel('Choices').fill('S, M, L');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Field added')).toBeVisible();
    await expect(page.getByText('t_shirt_size')).toBeVisible();
    await expectAccessible(page);

    await page.goto('/employees');
    await page.getByRole('link', { name: new RegExp(users.dev.name) }).click();
    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'Profile' }).click();
    const card = page.getByRole('heading', { name: 'More details' }).locator('xpath=ancestor::*[@data-slot="card"][1]');
    await card.getByRole('button', { name: 'Edit' }).click();
    await card.getByLabel('T-shirt size').selectOption('M');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(card.getByText('M', { exact: true })).toBeVisible();

    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'Time Off' }).click();
    await expect(page.getByRole('table', { name: 'Leave requests' }).getByText('Approved')).toBeVisible();
    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'Documents' }).click();
    await expect(page.getByRole('heading', { name: 'Employment documents' })).toBeVisible();
    await expectAccessible(page);
  });

  test('an admin adds a webhook and an API key, each secret shown once, and both are audited', async ({ page }) => {
    await signIn(page, users.owner);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Integrations' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Add webhook' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Endpoint URL').fill('https://hooks.example.com/orbit');
    await dialog.getByRole('checkbox', { name: /leave\.approved/ }).check();
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Save' }).click();
    dialog = page.getByRole('dialog', { name: 'Signing secret' });
    await expect(dialog.getByLabel('Secret value')).toHaveValue(/.{32,}/);
    await dialog.getByRole('button', { name: 'I have stored it' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: 'https://hooks.example.com/orbit' })).toBeVisible();

    await page.getByRole('button', { name: 'Create key' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Payroll sync');
    await dialog.getByRole('checkbox', { name: /employees\.read/ }).check();
    await dialog.getByRole('button', { name: 'Create key' }).click();
    dialog = page.getByRole('dialog', { name: 'Your API key' });
    await expect(dialog.getByLabel('Secret value')).toHaveValue(/^orb_/);
    await dialog.getByRole('button', { name: 'I have stored it' }).click();
    const keys = page.getByRole('table', { name: 'API keys' });
    const row = keys.getByRole('row', { name: /Payroll sync/ });
    await expect(row).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: 'Revoke Payroll sync' }).click();
    await expect(row.getByText('Revoked')).toBeVisible();

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit Logs' }).click();
    const log = page.getByRole('table', { name: 'Audit log entries' });
    await expect(log.getByText('apikeys.revoked')).toBeVisible();
    await page.getByLabel('Action').selectOption('webhooks.');
    await expect(log.getByText('webhooks.created')).toBeVisible();
    await expect(log.getByText('apikeys.revoked')).toHaveCount(0);
    await expectAccessible(page);
  });

  test('an employee cannot reach admin integrations or audit logs', async ({ page }) => {
    await signIn(page, users.dev);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Audit Logs' })).toHaveCount(0);
    await page.goto('/audit-logs');
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
