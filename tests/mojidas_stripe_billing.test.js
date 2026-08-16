const assert = require('assert');

const {
  MojidasBillingError,
  MojidasStripeBillingService,
} = require('../modules/billing/mojidas_stripe_billing');

async function main() {
  const checkoutCreateCalls = [];
  const checkoutRetrieveCalls = [];
  const grantCalls = [];
  let retrievedSession = paidSession();
  const stripeClient = {
    checkout: {
      sessions: {
        async create(parameters, options) {
          checkoutCreateCalls.push({ parameters, options });
          return {
            id: 'cs_test_123',
            url: 'https://checkout.stripe.com/c/pay/cs_test_123',
            expires_at: 1786672800,
          };
        },
        async retrieve(sessionID, options) {
          checkoutRetrieveCalls.push({ sessionID, options });
          return retrievedSession;
        },
      },
    },
    webhooks: {
      constructEvent(rawBody, signature, secret) {
        assert(Buffer.isBuffer(rawBody));
        assert.strictEqual(signature, 'test-signature');
        assert.strictEqual(secret, 'whsec_test');
        return completedEvent();
      },
    },
  };
  const creditStore = {
    async grantCredit(value) {
      grantCalls.push(value);
      return 'grant-1';
    },
  };
  const environment = {
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PRICE_CREDIT_60M_JPY: 'price_60m',
    STRIPE_PRICE_CREDIT_10H_JPY: 'price_10h',
  };
  const service = new MojidasStripeBillingService({
    stripeClient,
    creditStore,
    environment,
  });

  const checkout = await service.createCheckoutSession({
    userID: 'user-1',
    email: 'user@example.com',
    productID: 'credit_60m_jpy',
  });
  assert.strictEqual(checkout.checkoutSessionID, 'cs_test_123');
  assert.strictEqual(checkout.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
  assert.strictEqual(checkoutCreateCalls.length, 1);
  assert.deepStrictEqual(checkoutCreateCalls[0].parameters.line_items, [{
    price: 'price_60m',
    quantity: 1,
  }]);
  assert.deepStrictEqual(checkoutCreateCalls[0].parameters.metadata, {
    mojidasUserID: 'user-1',
    mojidasProductID: 'credit_60m_jpy',
  });
  assert.strictEqual(checkoutCreateCalls[0].parameters.mode, 'payment');

  const event = service.constructWebhookEvent(
    Buffer.from('{"id":"evt_test"}'),
    'test-signature'
  );
  const result = await service.processWebhookEvent(event);
  assert.deepStrictEqual(result, {
    handled: true,
    credited: true,
    userID: 'user-1',
    productID: 'credit_60m_jpy',
  });
  assert.deepStrictEqual(checkoutRetrieveCalls, [{
    sessionID: 'cs_test_123',
    options: { expand: ['line_items'] },
  }]);
  assert.strictEqual(grantCalls.length, 1);
  assert.strictEqual(grantCalls[0].type, 'purchased');
  assert.strictEqual(grantCalls[0].milliseconds, 60 * 60 * 1000);
  assert.strictEqual(grantCalls[0].expiresAt, null);
  assert.strictEqual(grantCalls[0].idempotencyKey, 'stripe:checkout:cs_test_123');

  retrievedSession = { ...paidSession(), payment_status: 'unpaid' };
  assert.deepStrictEqual(
    await service.processWebhookEvent(completedEvent()),
    { handled: true, credited: false }
  );
  assert.strictEqual(grantCalls.length, 1);

  retrievedSession = {
    ...paidSession(),
    line_items: {
      data: [{ price: { id: 'price_10h' }, quantity: 1 }],
    },
  };
  await assert.rejects(
    () => service.processWebhookEvent(completedEvent()),
    (error) => error instanceof MojidasBillingError && error.code === 'INVALID_WEBHOOK'
  );
  assert.strictEqual(grantCalls.length, 1);

  assert.deepStrictEqual(
    await service.processWebhookEvent({ id: 'evt_other', type: 'customer.created' }),
    { handled: false, credited: false }
  );

  console.log('Mojidas Stripe Checkout/Webhook: 商品検証と購入時間付与テストに成功しました。');
}

function completedEvent() {
  return {
    id: 'evt_test',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_123' } },
  };
}

function paidSession() {
  return {
    id: 'cs_test_123',
    payment_status: 'paid',
    payment_intent: 'pi_test_123',
    client_reference_id: 'user-1',
    metadata: {
      mojidasUserID: 'user-1',
      mojidasProductID: 'credit_60m_jpy',
    },
    line_items: {
      data: [{ price: { id: 'price_60m' }, quantity: 1 }],
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
