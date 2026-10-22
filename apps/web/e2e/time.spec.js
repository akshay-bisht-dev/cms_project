import { expect, test } from '@playwright/test';
import { expectAccessible, signIn, users } from './helpers.js';

/** Today's local date in the seeded organization's zone, unless that is too close to midnight. */
function safeDate() {
  const zone = 'Asia/Kolkata';
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const day = new Date(Date.now() - (hour < 2 ? 86_400_000 : 0));
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(day);
}

test.describe.serial('attendance, timer and timesheets', () => {
  test('an employee clocks in, runs the timer, clocks out, adds time and submits the timesheet', async ({ page }) => {
    await signIn(page, users.dev);
    const topbar = page.getByRole('banner');

    await topbar.getByRole('button', { name: 'Clock in' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clock in' }).click();
    await expect(page.getByText('Clocked in', { exact: true }).first()).toBeVisible();

    await page.getByLabel('What are you working on?').fill('Fix login bug');
    await page.getByLabel('Billable').check();
    await page.getByRole('button', { name: 'Start timer' }).click();
    await expect(page.getByText('Fix login bug')).toBeVisible();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByText('Paused: Fix login bug')).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(topbar.getByRole('button', { name: 'Clock in' })).toBeVisible();

    await page.goto('/time');
    await expect(page.getByText('Fix login bug').first()).toBeVisible();
    await page.getByRole('button', { name: 'Add time' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Date').fill(safeDate());
    await dialog.getByLabel('Start').fill('00:10');
    await dialog.getByLabel('End').fill('00:40');
    await dialog.getByLabel('Description').fill('Planning');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Entry added')).toBeVisible();
    await expect(page.getByText('Planning')).toBeVisible();
    await expectAccessible(page);

    await page.goto('/timesheets');
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByText('Timesheet submitted for approval')).toBeVisible();
    await expect(page.getByText('Submitted').first()).toBeVisible();
    await expectAccessible(page);

    await page.goto('/attendance');
    await expect(page.getByRole('tab', { name: 'My attendance' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Present').first()).toBeVisible();
    await expectAccessible(page);
  });

  test('the team lead sees the submission and approves it', async ({ page }) => {
    await signIn(page, users.lead);
    await expect(page.getByRole('button', { name: /Notifications, \d+ unread/ })).toBeVisible();
    await page.goto('/timesheets?view=approvals');
    const row = page.getByRole('row', { name: /Dev Patel/ });
    await row.getByRole('link').click();
    await expect(page.getByRole('heading', { name: /Timesheet · Dev Patel/ })).toBeVisible();
    await expect(page.getByText('Planning')).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Timesheet approved')).toBeVisible();
    await expect(page.getByText('Approved by Tomás Lee')).toBeVisible();

    await page.goto('/attendance?tab=team');
    await expect(page.getByRole('table', { name: 'Team presence' }).getByRole('link', { name: /Dev Patel/ })).toBeVisible();
    await expectAccessible(page);
  });

  test('the owner creates a work schedule', async ({ page }) => {
    await signIn(page, users.owner);
    await page.goto('/settings/attendance');
    await page.getByRole('button', { name: 'New schedule' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Office hours');
    await dialog.getByLabel('Default for everyone').check();
    await dialog.getByRole('button', { name: 'Save schedule' }).click();
    await expect(page.getByText('Schedule saved')).toBeVisible();
    await expect(page.getByText('Mon 09:00–18:00').first()).toBeVisible();
    await expectAccessible(page);
  });
});
