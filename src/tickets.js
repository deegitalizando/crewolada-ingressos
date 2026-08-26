const crypto = require('crypto');
const QRCode = require('qrcode');
const { buildTicketPdf } = require('./pdf');

function generateTicketCode() {
  const random = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `CRW-${random}`;
}

async function buildTicketsForOrder(order, eventInfo) {
  const tickets = [];
  for (let i = 0; i < order.quantity; i += 1) {
    const code = generateTicketCode();
    const qrCodeDataUrl = await QRCode.toDataURL(code, { margin: 1, width: 320 });
    const qrCodeBase64 = qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
    const ticket = {
      id: crypto.randomUUID(),
      orderId: order.id,
      code,
      qrCodeDataUrl,
      qrCodeBase64,
      status: 'valid',
      usedAt: null,
      createdAt: new Date().toISOString(),
    };
    const pdfBuffer = await buildTicketPdf({ eventInfo, order, ticket });
    ticket.pdfBase64 = pdfBuffer.toString('base64');
    tickets.push(ticket);
  }
  return tickets;
}

module.exports = { generateTicketCode, buildTicketsForOrder };
