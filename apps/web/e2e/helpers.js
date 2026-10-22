import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { E2E_PASSWORD } from '../playwright.config.mjs';

export const users = {
  owner: { email: 'owner@acme-it.test', name: 'Acme Owner' },
  hr: { email: 'hr@acme-it.test', name: 'Hana Rao' },
  lead: { email: 'lead@acme-it.test', name: 'Tomás Lee' },
  dev: { email: 'dev1@acme-it.test', name: 'Dev Patel' },
  peer: { email: 'dev2@acme-it.test', name: 'Elena Novak' },
  pm: { email: 'pm@acme-it.test', name: 'Priya Menon' },
};

const cspViolations = new WeakMap();

/** Records Content-Security-Policy violations reported in the console; expectAccessible fails on any. */
export function watchCsp(page) {
  if (cspViolations.has(page)) return;
  const seen = [];
  cspViolations.set(page, seen);
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) seen.push(msg.text());
  });
}

export async function signIn(page, user, password = E2E_PASSWORD) {
  watchCsp(page);
  await page.goto('/login');
  await page.getByLabel('Work email').fill(user.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/my-dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(user.name.split(' ')[0]);
}

export async function signOut(page, user) {
  await page.getByRole('button', { name: `Account menu for ${user.name}` }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL('**/login');
}

/** Fails on serious or critical axe violations (WCAG 2.x A/AA rules). */
export async function expectAccessible(page) {
  expect(cspViolations.get(page) ?? [], 'Content-Security-Policy violations').toEqual([]);
  watchCsp(page);
  // Scan the settled UI: mid-transition opacity (e.g. a toast fading in) is not what users read.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5000 }).catch(() => {});
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const blocking = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}
