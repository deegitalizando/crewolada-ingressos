const store = require('./store');
const { buildTicketsForOrder } = require('./tickets');
const { notifyOrderApproved } = require('./n8n');

// Marks an order paid and issues its tickets, exactly once. Both the
// synchronous payment response (card) and the async Mercado Pago webhook
// (Pix, boleto, or a delayed card confirmation) call this, so it must be
// idempotent — whichever arrives first wins, the other becomes a no-op.
async function approveOrder(orderId, paymentId, eventInfo) {
  let approvedOrder = null;

  await store.withDb((db) => {
    const order = db.orders[orderId];
    if (!order) return;
    if (order.status === 'paid') return;

    order.status = 'paid';
    order.mpPaymentId = String(paymentId);
    order.updatedAt = new Date().toISOString();
    approvedOrder = { ...order };
  });

  if (!approvedOrder) return null;

  const tickets = await buildTicketsForOrder(approvedOrder, eventInfo);
  await store.withDb((db) => {
    tickets.forEach((t) => {
      db.tickets[t.code] = t;
    });
  });

  await notifyOrderApproved(approvedOrder, tickets);

  return { order: approvedOrder, tickets };
}

module.exports = { approveOrder };
