const crypto = require('crypto');
const QRCode = require('qrcode');
const { buildTicketPdf } = require('./pdf');

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
  for (let i = 0; i < order.quantity; i += 1) {
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
