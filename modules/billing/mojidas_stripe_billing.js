const mojidasCreditStore = require('../credit/mojidas_credit_store');
const { PRODUCT_DEFINITIONS } = require('../mojidas_service_configuration');

const CHECKOUT_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

class MojidasBillingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MojidasBillingError';
    this.code = code;
  }
}

class MojidasStripeBillingService {
  constructor({
    stripeClient = null,
    creditStore = mojidasCreditStore,
    environment = process.env,
  } = {}) {
    this.creditStore = creditStore;
    this.environment = environment;
    this.stripeClient = stripeClient;
  }

  get stripe() {
    if (this.stripeClient) return this.stripeClient;
    const secretKey = String(this.environment.STRIPE_SECRET_KEY || '').trim();
    if (!secretKey) {
      throw new MojidasBillingError(
        'STRIPE_NOT_CONFIGURED',
        '決済サービスの設定が完了していません。'
      );
    }
    // 設定がない開発環境でも他のMojidas APIを起動できるよう遅延ロードする。
    const Stripe = require('stripe');
    this.stripeClient = new Stripe(secretKey);
    return this.stripeClient;
  }

  product(productID) {
    const product = PRODUCT_DEFINITIONS[String(productID || '').trim()];
    if (!product) {
      throw new MojidasBillingError('INVALID_PRODUCT', '購入する商品を確認してください。');
    }
    const priceID = String(this.environment[product.priceEnvironmentKey] || '').trim();
    if (!priceID) {
      throw new MojidasBillingError(
        'STRIPE_NOT_CONFIGURED',
        '購入商品の設定が完了していません。'
      );
    }
    return { ...product, priceID };
  }

  async createCheckoutSession({ userID, email, productID }) {
    if (!userID || !email) {
      throw new MojidasBillingError('INVALID_CUSTOMER', 'アカウント情報を確認してください。');
    }
    const product = this.product(productID);
    const successURL = String(
      this.environment.MOJIDAS_CHECKOUT_SUCCESS_URL
        || 'https://app.mojidas.jp/api/mojidas/billing/success?session_id={CHECKOUT_SESSION_ID}'
    ).trim();
    const cancelURL = String(
      this.environment.MOJIDAS_CHECKOUT_CANCEL_URL
        || 'https://app.mojidas.jp/api/mojidas/billing/cancel'
    ).trim();

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'ja',
      customer_email: email,
      client_reference_id: userID,
      line_items: [{ price: product.priceID, quantity: 1 }],
      success_url: successURL,
      cancel_url: cancelURL,
      metadata: {
        mojidasUserID: userID,
        mojidasProductID: product.id,
      },
      payment_intent_data: {
        receipt_email: email,
        metadata: {
          mojidasUserID: userID,
          mojidasProductID: product.id,
        },
      },
    }, {
      idempotencyKey: `mojidas-checkout:${userID}:${product.id}:${Date.now()}`,
    });

    if (!session || !session.id || !session.url) {
      throw new MojidasBillingError(
        'CHECKOUT_CREATE_FAILED',
        '購入ページを作成できませんでした。'
      );
    }
    return {
      checkoutSessionID: session.id,
      url: session.url,
      expiresAt: session.expires_at
        ? new Date(session.expires_at * 1000).toISOString()
        : null,
    };
  }

  constructWebhookEvent(rawBody, signature) {
    const webhookSecret = String(this.environment.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!webhookSecret) {
      throw new MojidasBillingError(
        'STRIPE_NOT_CONFIGURED',
        '決済Webhookの設定が完了していません。'
      );
    }
    if (!Buffer.isBuffer(rawBody) || !signature) {
      throw new MojidasBillingError('INVALID_WEBHOOK', '決済通知を確認できませんでした。');
    }
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (error) {
      throw new MojidasBillingError('INVALID_WEBHOOK', '決済通知を確認できませんでした。');
    }
  }

  async processWebhookEvent(event) {
    if (!event || !CHECKOUT_EVENT_TYPES.has(event.type)) {
      return { handled: false, credited: false };
    }

    const eventSession = event.data && event.data.object;
    if (!eventSession || !eventSession.id) {
      throw new MojidasBillingError('INVALID_WEBHOOK', '決済情報が不足しています。');
    }

    // Webhook payloadのmetadataだけを信用せず、Stripeから最新Sessionと明細を再取得する。
    const session = await this.stripe.checkout.sessions.retrieve(eventSession.id, {
      expand: ['line_items'],
    });
    if (session.payment_status !== 'paid') {
      return { handled: true, credited: false };
    }

    const userID = String(
      (session.metadata && session.metadata.mojidasUserID)
        || session.client_reference_id
        || ''
    ).trim();
    const product = this.product(
      session.metadata && session.metadata.mojidasProductID
    );
    if (!userID || userID.length > 128) {
      throw new MojidasBillingError('INVALID_WEBHOOK', '購入者を確認できませんでした。');
    }

    const lineItems = session.line_items && Array.isArray(session.line_items.data)
      ? session.line_items.data
      : [];
    const matchingQuantity = lineItems.reduce((sum, item) => {
      const priceID = item && item.price && item.price.id;
      return priceID === product.priceID ? sum + Number(item.quantity || 0) : sum;
    }, 0);
    if (lineItems.length !== 1 || matchingQuantity !== 1) {
      throw new MojidasBillingError('INVALID_WEBHOOK', '購入商品を確認できませんでした。');
    }

    await this.creditStore.grantCredit({
      userID,
      type: 'purchased',
      label: product.label,
      milliseconds: product.milliseconds,
      expiresAt: null,
      sourceReference: `stripe:checkout:${session.id}`,
      idempotencyKey: `stripe:checkout:${session.id}`,
      metadata: {
        stripeEventID: event.id || null,
        stripeCheckoutSessionID: session.id,
        stripePaymentIntentID: session.payment_intent || null,
        productID: product.id,
        totalJPY: product.totalJPY,
      },
    });

    return {
      handled: true,
      credited: true,
      userID,
      productID: product.id,
    };
  }
}

function createStripeWebhookHandler({ billingService = mojidasStripeBillingService } = {}) {
  return async function stripeWebhookHandler(req, res) {
    let event;
    try {
      event = billingService.constructWebhookEvent(
        req.body,
        req.get('Stripe-Signature')
      );
    } catch (error) {
      const status = error && error.code === 'INVALID_WEBHOOK' ? 400 : 503;
      return res.status(status).json({ received: false });
    }

    try {
      const result = await billingService.processWebhookEvent(event);
      return res.json({ received: true, handled: result.handled });
    } catch (error) {
      console.error('Failed to process Mojidas Stripe webhook:', error);
      // 5xxにしてStripeの自動再送を利用する。
      return res.status(500).json({ received: false });
    }
  };
}

const mojidasStripeBillingService = new MojidasStripeBillingService();

module.exports = {
  CHECKOUT_EVENT_TYPES,
  MojidasBillingError,
  MojidasStripeBillingService,
  PRODUCT_DEFINITIONS,
  createStripeWebhookHandler,
  mojidasStripeBillingService,
};
