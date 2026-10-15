const crypto = require('crypto');
const QRCode = require('qrcode');
const { buildTicketPdf } = require('./pdf');
const { expandKinds } = require('./produtos');

function generateTicketCode() {
  const random = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `CRW-${random}`;
}

// Builds the ticket records (code + QR) for an order. Draw numbers are NOT
// assigned here — they're handed out atomically by fulfillment.js via the
// store's write queue, so two orders processed at the same time can never
// receive the same number.
async function buildTicketRecords(order) {
  const tickets = [];
  const kinds = expandKinds(order);
  for (let i = 0; i < order.quantity; i += 1) {
    const item = kinds[i] || null;
    const code = generateTicketCode();
    const qrCodeDataUrl = await QRCode.toDataURL(code, { margin: 1, width: 320 });
    const qrCodeBase64 = qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
    tickets.push({
      id: crypto.randomUUID(),
      orderId: order.id,
      code,
      qrCodeDataUrl,
      qrCodeBase64,
      drawNumber: null,
      status: 'valid',
      usedAt: null,
      // Who actually attends with this specific ticket, for orders with more
      // than one ticket. Null until the buyer fills it in on /pedido/:id/participantes;
      // order.buyerName/Email/Phone is used as the fallback everywhere this is displayed.
      // Product orders: which category this ticket is (adulto/crianca/bebe),
      // its own price and what it includes. Babies get no food.
      kind: item ? item.kind : null,
      kindLabel: item ? item.label : null,
      price: item ? item.unitPrice : null,
      includes: item && item.kind !== 'bebe' && Array.isArray(order.includes) ? order.includes : [],
      participantName: null,
      participantEmail: null,
      participantPhone: null,
      createdAt: new Date().toISOString(),
    });
  }
  return tickets;
}

async function attachPdf(ticket, order, eventInfo) {
  const pdfBuffer = await buildTicketPdf({ eventInfo, order, ticket });
  ticket.pdfBase64 = pdfBuffer.toString('base64');
  return ticket;
}

module.exports = { generateTicketCode, buildTicketRecords, attachPdf };
