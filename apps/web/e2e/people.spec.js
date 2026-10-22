import { expect, test } from '@playwright/test';
import { expectAccessible, signIn, users } from './helpers.js';

async function openProfile(page, name, tab = 'Profile') {
  await page.goto('/employees');
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  if (tab !== 'Dashboard') await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: tab }).click();
}

test.describe.serial('people across roles', () => {
  test('HR searches the directory and edits an employee’s contact details', async ({ page }) => {
    await signIn(page, users.hr);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'People' }).click();
    const table = page.getByRole('table', { name: 'Employees' });
    await expect(table.getByRole('link', { name: /Dev Patel/ })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('textbox', { name: /Search by name/ }).fill('Elena');
    await expect(table.getByRole('row')).toHaveCount(2); // header + Elena
    await expect(page).toHaveURL(/q=Elena/);

    await openProfile(page, users.dev.name);
    await expect(page.getByRole('heading', { name: 'Personal details' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit contact' }).click();
    await page.getByRole('dialog').getByLabel('Phone').fill('+91 98000 11111');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Contact saved')).toBeVisible();
    await expect(page.getByText('+91 98000 11111')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'Activity' }).click();
    await expect(page.getByText(/Phone/)).toBeVisible();
  });

  test('an employee sees the notification, edits only their own self-service fields, and cannot see a peer’s private data', async ({ page }) => {
    await signIn(page, users.dev);
    await expect(page.getByRole('button', { name: /Notifications, \d+ unread/ })).toBeVisible();
    await expect(page.getByText('Hana Rao updated your profile').first()).toBeVisible();

    await page.getByRole('button', { name: `Account menu for ${users.dev.name}` }).click();
    await page.getByRole('menuitem', { name: 'My profile' }).click();
    await expect(page.getByRole('button', { name: 'Edit contact' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit personal details' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit basic information' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Edit personal details' }).click();
    await page.getByRole('dialog').getByLabel('Personal email').fill('dev.home@example.test');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('dev.home@example.test')).toBeVisible();

    await page.goto('/employees');
    await expect(page.getByRole('button', { name: 'Invite employee' })).toHaveCount(0);
    await openProfile(page, users.peer.name);
    await expect(page.getByRole('heading', { name: 'Basic information' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Personal details' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Contact' })).toHaveCount(0);
  });

  test('the owner invites an employee and sees them as invited', async ({ page }) => {
    await signIn(page, users.owner);
    await page.goto('/employees');
    await page.getByRole('button', { name: 'Invite employee' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill('Iris Newhire');
    await dialog.getByLabel('Work email').fill('iris@acme-it.test');
    await dialog.getByLabel('Department').selectOption({ label: 'Engineering' });
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText('Invitation sent to iris@acme-it.test')).toBeVisible();
    const row = page.getByRole('row', { name: /Iris Newhire/ });
    await expect(row.getByText('Invited')).toBeVisible();

    await page.goto('/dashboard');
    await expect(page.getByText('Active employees', { exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Active people by department', includeHidden: true })).toBeAttached();
    await expectAccessible(page);
  });

  test('a team lead manages only their own team', async ({ page }) => {
    await signIn(page, users.lead);
    await page.goto('/teams');
    const platform = page.getByRole('row', { name: /Platform/ });
    await expect(platform.getByRole('button', { name: 'Manage members' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New team' })).toHaveCount(0);
    await expectAccessible(page);
  });
});
