import { describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../../src/repositories/tx.js';

const sleep = vi.fn(async () => {});

function prismaFailing(errors, result = 'ok') {
  const queue = [...errors];
  return {
    $transaction: vi.fn(async (fn) => {
      const next = queue.shift();
      if (next) throw next;
      return fn('tx');
    }),
    result,
  };
}

describe('withTransaction', () => {
  it('retries deadlocks and then succeeds', async () => {
    const prisma = prismaFailing([new Error('Deadlock found when trying to get lock'), { code: 'P2034' }]);
    await expect(withTransaction(prisma, async (tx) => `ran in ${tx}`, { sleep })).resolves.toBe('ran in tx');
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts', async () => {
    const deadlock = { code: 'P2034' };
    const prisma = prismaFailing([deadlock, deadlock, deadlock]);
    await expect(withTransaction(prisma, async () => 'never', { sleep })).rejects.toBe(deadlock);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const boom = new Error('constraint violated');
    const prisma = prismaFailing([boom]);
    await expect(withTransaction(prisma, async () => 'never', { sleep })).rejects.toBe(boom);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
