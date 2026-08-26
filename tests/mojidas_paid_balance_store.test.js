const assert = require('assert');

const {
  REPORTING_THRESHOLD_JPY,
  summarizePaidBalance,
} = require('../modules/billing/mojidas_paid_balance_store');

function document(id, data) {
  return { id, data: () => data };
}

function main() {
  const now = new Date('2026-08-26T00:00:00.000Z');
  const complete = summarizePaidBalance({
    now,
    grantDocuments: [
      document('grant-60m', {
        type: 'purchased',
        label: '60分購入',
        totalMilliseconds: 3_600_000,
        remainingMilliseconds: 1_800_000,
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        metadata: { productID: 'credit_60m_jpy', totalJPY: 330 },
      }),
      document('grant-10h', {
        type: 'purchased',
        label: '10時間購入',
        totalMilliseconds: 36_000_000,
        remainingMilliseconds: 18_000_000,
      }),
      document('expired', {
        type: 'purchased',
        totalMilliseconds: 3_600_000,
        remainingMilliseconds: 3_600_000,
        expiresAt: new Date('2026-08-25T00:00:00.000Z'),
        metadata: { productID: 'credit_60m_jpy', totalJPY: 330 },
      }),
    ],
    ledgerDocuments: [
      document('ledger-10h', {
        grantID: 'grant-10h',
        metadata: { productID: 'credit_10h_jpy', totalJPY: 2970 },
      }),
    ],
    reservationDocuments: [
      document('active-media-reservation', {
        status: 'held',
        consumedMilliseconds: 0,
        allocations: [{ grantID: 'grant-60m', milliseconds: 900_000 }],
      }),
      document('completed-reservation', {
        status: 'completed',
        consumedMilliseconds: 900_000,
        allocations: [{ grantID: 'grant-60m', milliseconds: 900_000 }],
      }),
    ],
  });

  assert.strictEqual(complete.isComplete, true);
  assert.strictEqual(complete.unusedPaidBalanceJPY, 1733);
  assert.strictEqual(complete.knownUnusedPaidBalanceJPY, 1733);
  assert.strictEqual(complete.totalRemainingMilliseconds, 20_700_000);
  assert.strictEqual(complete.purchaseGrantCount, 2);
  assert.strictEqual(complete.breakdown.length, 2);
  assert.strictEqual(complete.reportingThresholdJPY, REPORTING_THRESHOLD_JPY);
  assert.strictEqual(complete.thresholdUsageRate, 1733 / REPORTING_THRESHOLD_JPY);

  const incomplete = summarizePaidBalance({
    now,
    grantDocuments: [
      document('known', {
        type: 'purchased',
        totalMilliseconds: 3_600_000,
        remainingMilliseconds: 1_800_000,
        metadata: { productID: 'credit_60m_jpy', totalJPY: 330 },
      }),
      document('unknown', {
        type: 'purchased',
        totalMilliseconds: 120_000,
        remainingMilliseconds: 60_000,
      }),
    ],
    ledgerDocuments: [],
  });

  assert.strictEqual(incomplete.isComplete, false);
  assert.strictEqual(incomplete.unusedPaidBalanceJPY, null);
  assert.strictEqual(incomplete.knownUnusedPaidBalanceJPY, 165);
  assert.strictEqual(incomplete.unvaluedGrantCount, 1);
  assert.strictEqual(incomplete.unvaluedRemainingMilliseconds, 60_000);
  assert.strictEqual(incomplete.thresholdUsageRate, null);

  const fullyReserved = summarizePaidBalance({
    now,
    grantDocuments: [document('fully-reserved-grant', {
      type: 'purchased',
      totalMilliseconds: 3_600_000,
      remainingMilliseconds: 0,
      metadata: { productID: 'credit_60m_jpy', totalJPY: 330 },
    })],
    ledgerDocuments: [],
    reservationDocuments: [document('reservation', {
      status: 'held',
      consumedMilliseconds: 0,
      allocations: [{ grantID: 'fully-reserved-grant', milliseconds: 1_800_000 }],
    })],
  });
  assert.strictEqual(fullyReserved.unusedPaidBalanceJPY, 165);
  assert.strictEqual(fullyReserved.totalRemainingMilliseconds, 1_800_000);

  console.log('Mojidas unused paid balance report tests passed');
}

main();
