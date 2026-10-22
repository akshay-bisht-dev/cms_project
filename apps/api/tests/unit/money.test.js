import { describe, expect, it } from 'vitest';
import { documentTotals, hoursFromSeconds, lineAmounts, minorUnits, moneyString, paymentStatus, roundMoney, toBase } from '../../src/modules/finance/money.js';

describe('money', () => {
  it('rounds half to even at the currency minor unit', () => {
    expect(roundMoney('2.345', 'USD').toFixed(2)).toBe('2.34');
    expect(roundMoney('2.355', 'USD').toFixed(2)).toBe('2.36');
    expect(roundMoney('-2.345', 'USD').toFixed(2)).toBe('-2.34');
    expect(roundMoney('1500.5', 'JPY').toFixed(0)).toBe('1500');
    expect(roundMoney('1501.5', 'JPY').toFixed(0)).toBe('1502');
    expect(roundMoney('1.0005', 'KWD').toFixed(3)).toBe('1.000');
    expect(minorUnits('EUR')).toBe(2);
  });

  it('never accumulates binary floating-point error', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004.
    const t = documentTotals([{ quantity: '1', unitPrice: '0.1' }, { quantity: '1', unitPrice: '0.2' }], 'USD');
    expect(t.total.toFixed(2)).toBe('0.30');
    const many = documentTotals(Array.from({ length: 1000 }, () => ({ quantity: '1', unitPrice: '0.01' })), 'USD');
    expect(many.total.toString()).toBe('10');
  });

  it('rounds each line, then sums rounded lines so totals always reconcile', () => {
    const lines = [
      { quantity: '1.3333', unitPrice: '75', taxRate: '0.18' }, // 99.9975 → 100.00; tax 18.00
      { quantity: '2.5', unitPrice: '19.99', taxRate: '0.07' }, // 49.975 → 49.98 (half-even); tax 3.4986 → 3.50
    ];
    expect(lineAmounts(lines[0], 'USD')).toEqual({ lineTotal: roundMoney('100.00', 'USD'), taxAmount: roundMoney('18.00', 'USD') });
    const t = documentTotals(lines, 'USD');
    expect([t.subtotal.toFixed(2), t.taxTotal.toFixed(2), t.total.toFixed(2)]).toEqual(['149.98', '21.50', '171.48']);
  });

  it('turns tracked seconds into exact hours', () => {
    expect(hoursFromSeconds(5400).toString()).toBe('1.5');
    expect(hoursFromSeconds(1000).toFixed(4)).toBe('0.2778');
    expect(lineAmounts({ quantity: hoursFromSeconds(1000), unitPrice: '120' }, 'USD').lineTotal.toFixed(2)).toBe('33.34');
  });

  it('converts to the base currency and formats as strings', () => {
    expect(toBase('100.00', '0.92345678', 'EUR').toFixed(2)).toBe('92.35');
    expect(moneyString('1234.5', 'USD')).toBe('1234.50');
    expect(moneyString('1234.5', 'JPY')).toBe('1234');
  });

  it('derives invoice status from payments only', () => {
    expect(paymentStatus('100.00', '0')).toBe('ISSUED');
    expect(paymentStatus('100.00', '40.00')).toBe('PARTIALLY_PAID');
    expect(paymentStatus('100.00', '100.00')).toBe('PAID');
    expect(paymentStatus('100.00', '120.00')).toBe('PAID');
    expect(paymentStatus('0', '0')).toBe('ISSUED'); // a zero invoice is never "paid" without a payment
  });
});
