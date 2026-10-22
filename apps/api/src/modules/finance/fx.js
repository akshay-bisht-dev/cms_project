import { dec, toBase } from './money.js';

/**
 * Converts amounts into the organization's base currency with rates entered by Finance (A8:
 * no external FX feed). The rate in force on `date` is the latest with effective_from ≤ date.
 * Amounts in a currency without a rate are reported as unconverted, never guessed.
 */
export function createFx(db, organizationId, baseCurrency) {
  const cache = new Map();
  async function rate(currency, date) {
    if (currency === baseCurrency) return dec(1);
    const day = date.toISOString().slice(0, 10);
    const key = `${currency}|${day}`;
    if (!cache.has(key)) {
      const row = await db.exchangeRate.findFirst({ where: { organizationId, currency, effectiveFrom: { lte: new Date(`${day}T00:00:00Z`) } }, orderBy: { effectiveFrom: 'desc' } });
      cache.set(key, row ? dec(row.rateToBase) : null);
    }
    return cache.get(key);
  }
  return {
    baseCurrency,
    rate,
    /** { amount (base) | null, missing: currency | null } */
    async convert(amount, currency, date = new Date()) {
      const r = await rate(currency, date);
      return r ? { amount: toBase(amount, r, baseCurrency), missing: null } : { amount: null, missing: currency };
    },
  };
}
