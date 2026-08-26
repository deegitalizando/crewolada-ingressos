const crypto = require('crypto');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const paymentApi = new Payment(client);

// Creates the payment directly (Checkout Transparente / Payment Brick) so the
// buyer never leaves our site. `formData` is whatever the Payment Brick's
// onSubmit callback produced on the frontend (token for card payments is
// absent for Pix; issuer_id/installments only apply to cards).
async function createPayment(order, formData) {
  const result = await paymentApi.create({
    body: {
      transaction_amount: Number(order.totalAmount),
      token: formData.token,
      description: `Ingresso ${process.env.EVENT_NAME} - ${order.loteName}`,
      installments: Number(formData.installments) || 1,
      payment_method_id: formData.payment_method_id,
      issuer_id: formData.issuer_id,
      payer: {
        email: order.buyerEmail,
        identification: {
          type: 'CPF',
          number: order.buyerCpf,
        },
      },
      external_reference: order.id,
      notification_url: `${process.env.BASE_URL}/api/webhooks/mercadopago`,
      statement_descriptor: 'CREWOLADA',
    },
    requestOptions: {
      idempotencyKey: crypto.randomUUID(),
    },
  });
  return result;
}

async function getPayment(paymentId) {
  return paymentApi.get({ id: paymentId });
}

// Validates the x-signature header Mercado Pago sends with webhook calls.
// See: https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks#editor_5
function isValidWebhookSignature({ xSignature, xRequestId, dataId }) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured, skip validation (dev mode)
  if (!xSignature) return false;

  const parts = Object.fromEntries(
    xSignature.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k.trim(), v && v.trim()];
    })
  );
  const ts = parts.ts;
  const receivedHash = parts.v1;
  if (!ts || !receivedHash) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId || ''};ts:${ts};`;
  const computedHash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(receivedHash));
}

module.exports = {
  createPayment,
  getPayment,
  isValidWebhookSignature,
};
