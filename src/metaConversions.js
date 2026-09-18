const crypto = require('crypto');
const axios = require('axios');
const { normalizePhone } = require('./n8n');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex');
}

// Reports an approved order to Meta's Conversions API. This is the primary
// Purchase signal for this app: checkout never redirects to Mercado Pago
// (Checkout Transparente/Payment Brick), so MP's own preference-based pixel
// integration doesn't apply, and Pix approvals happen async via webhook,
// often after the buyer has already left the page — a client-side pixel
// alone would miss most of them. `eventId` should match the one used by the
// browser-side fbq('track', 'Purchase', ..., { eventID }) call for the same
// order so Meta deduplicates the two signals instead of double-counting.
async function trackPurchase(order, eventId) {
  const pixelId = process.env.FACEBOOK_PIXEL_ID;
  const accessToken = process.env.FACEBOOK_CAPI_ACCESS_TOKEN;
  if (!pixelId || !accessToken) return;

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: process.env.BASE_URL,
        user_data: {
          em: [sha256(order.buyerEmail)],
          ph: [sha256(normalizePhone(order.buyerPhone))],
        },
        custom_data: {
          currency: 'BRL',
          value: Number(order.totalAmount),
          order_id: order.id,
          content_type: 'product',
          content_name: order.loteName,
          num_items: order.quantity,
        },
      },
    ],
  };

  // Set FACEBOOK_TEST_EVENT_CODE (from Events Manager > Test Events) while
  // validating so real purchases show up there instead of mixing into live
  // ad reporting. Leave unset in normal production use.
  if (process.env.FACEBOOK_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.FACEBOOK_TEST_EVENT_CODE;
  }

  try {
    await axios.post(`https://graph.facebook.com/v21.0/${pixelId}/events`, payload, {
      params: { access_token: accessToken },
      timeout: 10000,
    });
  } catch (err) {
    console.error('Falha ao enviar Purchase ao Meta Conversions API:', err.response?.data || err.message);
  }
}

module.exports = { trackPurchase };
