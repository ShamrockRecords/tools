const assert = require('assert');

const {
  DEFAULT_MONTHLY_FREE_MINUTES,
  monthlyFreeMilliseconds,
  monthlyFreeMinutes,
  publicServiceConfiguration,
} = require('../modules/mojidas_service_configuration');

function main() {
  assert.strictEqual(DEFAULT_MONTHLY_FREE_MINUTES, 30);
  assert.strictEqual(monthlyFreeMinutes({}), DEFAULT_MONTHLY_FREE_MINUTES);
  assert.strictEqual(monthlyFreeMilliseconds({}), 1_800_000);
  assert.strictEqual(monthlyFreeMinutes({ MOJIDAS_MONTHLY_FREE_MINUTES: '30' }), 30);
  assert.strictEqual(monthlyFreeMilliseconds({ MOJIDAS_MONTHLY_FREE_MINUTES: '30' }), 1_800_000);
  assert.strictEqual(
    monthlyFreeMinutes({ MOJIDAS_MONTHLY_FREE_MINUTES: 'not-a-number' }),
    DEFAULT_MONTHLY_FREE_MINUTES
  );
  assert.strictEqual(
    monthlyFreeMinutes({ MOJIDAS_MONTHLY_FREE_MINUTES: '0' }),
    DEFAULT_MONTHLY_FREE_MINUTES
  );
  assert.strictEqual(
    monthlyFreeMinutes({ MOJIDAS_MONTHLY_FREE_MINUTES: '30minutes' }),
    DEFAULT_MONTHLY_FREE_MINUTES
  );

  const configuration = publicServiceConfiguration({
    MOJIDAS_MONTHLY_FREE_MINUTES: '30',
  });
  assert.strictEqual(configuration.schemaVersion, 1);
  assert.strictEqual(configuration.monthlyFreeAllowanceMilliseconds, 1_800_000);
  assert.deepStrictEqual(configuration.products, [
    {
      id: 'credit_60m_jpy',
      label: '60分購入',
      milliseconds: 3_600_000,
      totalJPY: 330,
      currency: 'JPY',
    },
    {
      id: 'credit_10h_jpy',
      label: '10時間購入',
      milliseconds: 36_000_000,
      totalJPY: 2200,
      currency: 'JPY',
    },
  ]);

  console.log('Mojidas service configuration tests passed');
}

main();
