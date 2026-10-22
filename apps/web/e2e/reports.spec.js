import { expect, test } from '@playwright/test';
import { expectAccessible, signIn, users } from './helpers.js';

test.describe.serial('activity, insights and reports', () => {
  test('an employee sees their own day as it is recorded', async ({ page }) => {
    await signIn(page, users.dev);
    const topbar = page.getByRole('banner');
    await topbar.getByRole('button', { name: 'Clock in' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clock in' }).click();
    await expect(page.getByText('Clocked in', { exact: true }).first()).toBeVisible();

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Activity' }).click();
    await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
    // An employee sees only themselves: no person picker, no team view.
    await expect(page.getByLabel('Person')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Team' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Day' }).click();
    await expect(page.getByText('Clocked in', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('Measured').first()).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('tab', { name: 'Week' }).click();
    await expect(page.getByText('Worked and tracked per day')).toBeVisible();
    await expectAccessible(page);

    await topbar.getByRole('button', { name: 'Time tracking: clocked in' }).click();
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(topbar.getByRole('button', { name: 'Clock in' })).toBeVisible();
  });

  test('a team lead sees the team for the day', async ({ page }) => {
    await signIn(page, users.lead);
    await page.goto('/activity?view=team');
    const table = page.getByRole('table', { name: 'Team overview' });
    await expect(table.getByText(users.dev.name)).toBeVisible();
    await expect(table.getByText(users.pm.name)).toHaveCount(0);
    await expectAccessible(page);
  });

  test('the owner runs a report, sees how each figure was obtained, and exports it', async ({ page }) => {
    await signIn(page, users.owner);
    await page.goto('/insights');
    await expect(page.getByRole('heading', { name: 'Attendance rate' })).toBeVisible();
    await expect(page.getByText('days present ÷ scheduled working days')).toBeVisible();
    await expectAccessible(page);

    await page.goto('/reports');
    await page.getByRole('button', { name: /^Attendance/ }).click();
    await page.getByRole('button', { name: 'Run' }).click();
    const table = page.getByRole('table', { name: 'Attendance' });
    await expect(table.getByRole('cell', { name: users.dev.name })).toBeVisible();
    await expect(table.getByRole('cell', { name: 'Total' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /Attendance rate\s*Derived/ })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Export CSV' }).click();
    await expect(page.getByText('Export started')).toBeVisible();
    await expect(page.getByText(/Attendance · .* · CSV/)).toBeVisible();
    await expect(page.getByText('Queued')).toBeVisible();
  });
});
