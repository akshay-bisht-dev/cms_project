import { expect, test } from '@playwright/test';
import { E2E_PASSWORD } from '../playwright.config.mjs';
import { expectAccessible, signIn, users } from './helpers.js';

const finance = { email: 'finance@acme-it.test', name: 'Farah Khan' };
const client = { email: 'client@acme-it.test', name: 'Bill Lumbergh' };

async function signInToPortal(page) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(client.email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Client users land in the portal, never the internal app.
  await page.waitForURL('**/portal');
}

test.describe.serial('clients, sales, support, finance and the client portal', () => {
  test('finance issues an invoice and records a partial payment', async ({ page }) => {
    await signIn(page, finance);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Invoices' }).click();
    await page.getByRole('button', { name: 'New invoice' }).click();
    await page.getByRole('dialog').getByLabel('Client').selectOption({ label: 'Initech Ltd (INR)' });
    await page.getByRole('dialog').getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByRole('heading', { name: 'Draft invoice' })).toBeVisible();

    await page.getByLabel('Line 1 description').fill('Discovery workshop');
    await page.getByLabel('Line 1 quantity').fill('2');
    await page.getByLabel('Line 1 unit price').fill('1250');
    await page.getByLabel('Line 1 tax %').fill('18');
    await page.getByRole('button', { name: 'Add lines' }).click();
    await expect(page.getByRole('cell', { name: '₹2,950.00' })).toBeVisible(); // 2 × 1250 + 18 % tax
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Issue' }).click();
    await expect(page.getByRole('heading', { name: /^Invoice INV-\d{5}$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Record payment' }).click();
    await page.getByRole('dialog').getByLabel('Amount (INR)').fill('1000');
    await page.getByRole('dialog').getByRole('button', { name: 'Record' }).click();
    await expect(page.getByText('Partly paid')).toBeVisible();
    await expect(page.getByText('₹1,950.00').first()).toBeVisible();
    await expectAccessible(page);
  });

  test('the owner converts a lead and sees it in the pipeline', async ({ page }) => {
    await signIn(page, users.owner);
    await page.goto('/leads');
    await page.getByRole('row', { name: /Peter Gibbons/ }).getByRole('button', { name: 'Convert' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Convert' }).click();
    await expect(page.getByRole('heading', { name: 'Chotchkies' })).toBeVisible();
    await expect(page.getByText('Peter Gibbons')).toBeVisible();
    await expectAccessible(page);
    await page.goto('/pipeline');
    await expect(page.getByRole('region', { name: /Prospecting/ }).getByText('Chotchkies opportunity')).toBeVisible();
    await expect(page.getByText('Estimated')).toBeVisible();
    await expectAccessible(page);
  });

  test('a developer answers the client’s ticket publicly and leaves an internal note', async ({ page }) => {
    await signIn(page, users.dev);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Support Tickets' }).click();
    await page.getByRole('link', { name: /T-1 · Cannot export TPS reports/ }).click();
    await page.getByLabel('Reply').fill('Thanks — we have reproduced it and a fix is on its way.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Reply sent')).toBeVisible();
    await page.getByLabel('Visibility').selectOption('INTERNAL');
    await page.getByLabel('Reply').fill('Root cause: export worker timeout.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Internal note', { exact: false }).first()).toBeVisible();
    await expectAccessible(page);
  });

  test('the client sees only their own data in the portal', async ({ page }) => {
    await signInToPortal(page);
    await expect(page.getByRole('heading', { name: 'Welcome, Initech Ltd' })).toBeVisible();
    await expect(page.getByText('Customer Portal')).toBeVisible(); // the shared project
    await expect(page.getByText('Internal Tools')).toHaveCount(0);
    await expectAccessible(page);

    await page.getByRole('navigation', { name: 'Portal' }).getByRole('link', { name: 'Support' }).click();
    await page.getByRole('link', { name: /T-1 · Cannot export TPS reports/ }).click();
    await expect(page.getByText('a fix is on its way')).toBeVisible();
    await expect(page.getByText('Root cause: export worker timeout.')).toHaveCount(0);
    await page.getByLabel('Your reply').fill('Great, thank you!');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Reply sent')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('navigation', { name: 'Portal' }).getByRole('link', { name: 'Invoices' }).click();
    await expect(page.getByRole('cell', { name: '₹2,950.00' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '₹1,950.00' })).toBeVisible();
    await expectAccessible(page);

    // The internal app is out of reach.
    await page.goto('/employees');
    await page.waitForURL('**/portal');
  });

  test('an employee submits an expense and the project manager approves it', async ({ page }) => {
    await signIn(page, users.peer);
    await page.goto('/expenses');
    await page.getByRole('button', { name: 'New expense' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('What for').fill('Taxi to client site');
    await dialog.getByLabel('Amount').fill('42.80');
    await dialog.getByLabel('Category').selectOption({ label: 'Travel' });
    await dialog.getByLabel('Project').selectOption({ label: 'PORTAL · Customer Portal' });
    await dialog.getByLabel('Bill to the client').check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Expense submitted for approval')).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: `Account menu for ${users.peer.name}` }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await signIn(page, users.pm);
    await page.goto('/expenses');
    await page.getByRole('tab', { name: 'To approve' }).click();
    await page.getByRole('row', { name: /Taxi to client site/ }).getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  });
});
