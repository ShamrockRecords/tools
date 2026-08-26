const DEFAULT_MONTHLY_FREE_MINUTES = 40;
const MIN_MONTHLY_FREE_MINUTES = 1;
const MAX_MONTHLY_FREE_MINUTES = 24 * 60;

const PRODUCT_DEFINITIONS = Object.freeze({
  credit_60m_jpy: Object.freeze({
    id: 'credit_60m_jpy',
    label: '60分購入',
    milliseconds: 60 * 60 * 1000,
    totalJPY: 330,
    currency: 'JPY',
    priceEnvironmentKey: 'STRIPE_PRICE_CREDIT_60M_JPY',
  }),
  credit_10h_jpy: Object.freeze({
    id: 'credit_10h_jpy',
    label: '10時間購入',
    milliseconds: 10 * 60 * 60 * 1000,
    totalJPY: 2970,
    currency: 'JPY',
    priceEnvironmentKey: 'STRIPE_PRICE_CREDIT_10H_JPY',
  }),
});

function monthlyFreeMinutes(environment = process.env) {
  const configured = Number(environment.MOJIDAS_MONTHLY_FREE_MINUTES);
  return Number.isSafeInteger(configured)
    && configured >= MIN_MONTHLY_FREE_MINUTES
    && configured <= MAX_MONTHLY_FREE_MINUTES
    ? configured
    : DEFAULT_MONTHLY_FREE_MINUTES;
}

function monthlyFreeMilliseconds(environment = process.env) {
  return monthlyFreeMinutes(environment) * 60 * 1000;
}

function publicServiceConfiguration(environment = process.env) {
  return {
    schemaVersion: 1,
    monthlyFreeAllowanceMilliseconds: monthlyFreeMilliseconds(environment),
    products: Object.values(PRODUCT_DEFINITIONS).map((product) => ({
      id: product.id,
      label: product.label,
      milliseconds: product.milliseconds,
      totalJPY: product.totalJPY,
      currency: product.currency,
    })),
  };
}

module.exports = {
  DEFAULT_MONTHLY_FREE_MINUTES,
  MAX_MONTHLY_FREE_MINUTES,
  MIN_MONTHLY_FREE_MINUTES,
  PRODUCT_DEFINITIONS,
  monthlyFreeMilliseconds,
  monthlyFreeMinutes,
  publicServiceConfiguration,
};
