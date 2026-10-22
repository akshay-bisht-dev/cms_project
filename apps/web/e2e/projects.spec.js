import { expect, test } from '@playwright/test';
import { expectAccessible, signIn, users } from './helpers.js';

test.describe.serial('projects and tasks', () => {
  test('a project manager plans work on the board and in the task page', async ({ page }) => {
    await signIn(page, users.pm);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();
    await page.getByRole('link', { name: /Customer Portal/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /Customer Portal/ })).toBeVisible();
    await expect(page.getByRole('region', { name: /^To do,/ })).toBeVisible();
    await expectAccessible(page);

    await page.getByLabel('Add task to To do').fill('Draft release checklist');
    await page.getByLabel('Add task to To do').press('Enter');
    const card = page.getByRole('article', { name: /Draft release checklist/ });
    await expect(card).toBeVisible();

    await card.getByRole('link', { name: 'Draft release checklist' }).click();
    await expect(page.getByLabel('Title')).toHaveValue('Draft release checklist');
    // Server-confirmed checkbox: it flips once the API has saved the assignment.
    await page.getByRole('checkbox', { name: 'Dev Patel' }).click();
    await expect(page.getByRole('checkbox', { name: 'Dev Patel' })).toBeChecked();
    await page.getByLabel('Due date').fill('2030-01-15');
    await page.getByLabel('Due date').blur();
    await page.getByLabel('New checklist item').fill('List breaking changes');
    await page.getByLabel('New checklist item').press('Enter');
    await expect(page.getByRole('checkbox', { name: 'List breaking changes' })).toBeVisible();
    await page.getByLabel('Write a comment').fill('Dev, please take this one.');
    await page.getByRole('button', { name: 'Comment' }).click();
    await expect(page.getByText('Dev, please take this one.')).toBeVisible();
    await expectAccessible(page);

    // Keyboard-accessible move between columns.
    await page.getByRole('link', { name: 'Customer Portal' }).click();
    await page.getByRole('article', { name: /Draft release checklist/ }).getByLabel('Move to').selectOption({ label: 'In progress' });
    await expect(page.getByRole('region', { name: /^In progress,/ }).getByRole('article', { name: /Draft release checklist/ })).toBeVisible();

    await page.goto('/project-management');
    await expect(page.getByRole('table', { name: 'Project portfolio' }).getByRole('link', { name: /Customer Portal/ })).toBeVisible();
    await expectAccessible(page);
  });

  test('the assignee finds it in My tasks, tracks time on it and completes it', async ({ page }) => {
    await signIn(page, users.dev);
    await expect(page.getByRole('button', { name: /Notifications, \d+ unread/ })).toBeVisible();
    await page.goto('/tasks');
    await page.getByRole('link', { name: /Draft release checklist/ }).click();
    await page.getByRole('button', { name: 'Track time' }).click();
    await expect(page.getByText('Timer started')).toBeVisible();
    await page.getByLabel('Status').selectOption({ label: 'Done' });
    await expect(page.getByText(/changed the status to Done/)).toBeVisible();
    await page.getByRole('banner').getByRole('button', { name: /Time tracking/ }).click();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByText('Timer stopped')).toBeVisible();
    // "Track time" clocked them in automatically; leave them clocked out for later specs.
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Clock in' })).toBeVisible();
    await page.goto('/time');
    await expect(page.getByText('Draft release checklist').first()).toBeVisible();
  });

  test('anyone can schedule a meeting that appears on the calendar', async ({ page }) => {
    await signIn(page, users.pm);
    await page.goto('/calendar');
    await page.getByRole('button', { name: 'New meeting' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Title').fill('Sprint review');
    await dialog.getByRole('checkbox', { name: 'Dev Patel' }).check();
    await dialog.getByRole('button', { name: 'Schedule' }).click();
    await expect(page.getByText('Meeting scheduled. Attendees were notified.')).toBeVisible();
    await expect(page.getByText('Sprint review')).toBeVisible();
    await expectAccessible(page);
  });
});
