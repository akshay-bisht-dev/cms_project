import { Prisma } from '@prisma/client';

// Exact decimal arithmetic for money (decimal.js via Prisma). Floats never touch amounts.
const D = Prisma.Decimal;
const HALF_EVEN = D.ROUND_HALF_EVEN;

/** ISO 4217 minor units; everything not listed uses 2. */
const MINOR_UNITS = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, UGX: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, IQD: 3, LYD: 3 };

export const minorUnits = (currency) => MINOR_UNITS[currency] ?? 2;
export const dec = (value) => new D(value ?? 0);

/**
 * Rounds to the currency's minor unit with banker's rounding (half to even), the default from
 * the requirements' open question 6: 2.345 → 2.34, 2.355 → 2.36.
 */
export function roundMoney(value, currency) {
  return dec(value).toDecimalPlaces(minorUnits(currency), HALF_EVEN);
}

/**
 * One line: total = round(quantity × unit price); tax = round(total × rate). Rounding happens
 * per line, and document totals are sums of rounded lines, so the parts always add up.
 */
export function lineAmounts({ quantity, unitPrice, taxRate = 0 }, currency) {
  const lineTotal = roundMoney(dec(quantity).times(dec(unitPrice)), currency);
  const taxAmount = roundMoney(lineTotal.times(dec(taxRate)), currency);
  return { lineTotal, taxAmount };
}

export function documentTotals(lines, currency) {
  let subtotal = dec(0);
  let taxTotal = dec(0);
  for (const line of lines) {
    const { lineTotal, taxAmount } = lineAmounts(line, currency);
    subtotal = subtotal.plus(lineTotal);
    taxTotal = taxTotal.plus(taxAmount);
  }
  return { subtotal, taxTotal, total: subtotal.plus(taxTotal) };
}

/** Hours from seconds as an exact decimal (4 places, the quantity column's scale). */
export function hoursFromSeconds(seconds) {
  return dec(seconds).dividedBy(3600).toDecimalPlaces(4, HALF_EVEN);
}

/** Converts into the base currency with a rate (1 unit = rate base units). */
export function toBase(amount, rate, baseCurrency) {
  return roundMoney(dec(amount).times(dec(rate)), baseCurrency);
}

/** Status of an issued invoice from the sum of its payments. */
export function paymentStatus(total, paid) {
  const t = dec(total);
  const p = dec(paid);
  if (p.gt(0) && p.gte(t)) return 'PAID';
  if (p.gt(0)) return 'PARTIALLY_PAID';
  return 'ISSUED';
}

/** Decimal → string with the currency's minor units, for JSON (never a float). */
export function moneyString(value, currency) {
  return value === null || value === undefined ? null : roundMoney(value, currency).toFixed(minorUnits(currency));
}

export const decString = (value, places = 4) => (value === null || value === undefined ? null : dec(value).toFixed(places));
