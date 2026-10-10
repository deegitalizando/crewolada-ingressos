const axios = require('axios');
const PDFDocument = require('pdfkit');
const store = require('./store');
const { normalizePhone } = require('./n8n');

const GOLD = '#c9911f';
const BLACK = '#0a0a0a';
const DIM = '#555555';

function brl(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace('.', ',')}`;
}

// Receipts are reachable by order id (same model as /pedido/:id), so the CPF
// is masked on both the page and the PDF.
function maskCpf(cpf) {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11) return '';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

function describePayment(order) {
  const id = String(order.paymentMethodId || '').toLowerCase();
  if (order.isCourtesy || id === 'cortesia') return 'Cortesia';
  if (id === 'pix') return 'Pix';
  if (!id) return 'Mercado Pago';
  return `Cartão (${id.toUpperCase()})`;
}

// Everything the receipt shows, computed once so the page, the PDF and the
// message sent to the customer can never disagree with each other.
function buildReceipt(order, tickets, formatDatetime) {
  const refund = order.refund || null;
  const isPix = String(order.paymentMethodId || '').toLowerCase() === 'pix';

  let refundTitle = 'Cancelado sem reembolso';
  let refundNote = 'Este pedido foi cancelado e nenhum valor foi devolvido por meio deste comprovante.';
  if (refund) {
    refundTitle = 'Reembolso realizado';
    if (refund.method === 'manual') {
      refundNote = 'O valor foi devolvido diretamente pela organização do evento.';
    } else if (isPix) {
      refundNote = 'O valor foi devolvido via Pix para a conta usada no pagamento. Costuma aparecer em poucos minutos, conforme o seu banco.';
    } else {
      refundNote = 'O valor foi estornado no cartão usado na compra. O lançamento pode levar de 1 a 2 faturas para aparecer, conforme o banco emissor.';
    }
  }

  return {
    protocol: String(order.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
    orderId: order.id,
    buyerName: order.buyerName,
    buyerEmail: order.buyerEmail,
    buyerCpfMasked: maskCpf(order.buyerCpf),
    loteName: order.loteName,
    quantity: order.quantity,
    totalLabel: order.isCourtesy ? 'Cortesia' : brl(order.totalAmount),
    paymentLabel: describePayment(order),
    mpPaymentId: /^\d+$/.test(String(order.mpPaymentId || '')) ? String(order.mpPaymentId) : '',
    purchasedAtLabel: formatDatetime(order.createdAt),
    cancelledAtLabel: formatDatetime(order.cancelledAt),
    ticketCodes: tickets.map((t) => t.code),
    hasRefund: Boolean(refund),
    refundTitle,
    refundNote,
    refundAmountLabel: refund ? brl(refund.amount != null ? refund.amount : order.totalAmount) : '',
    refundIsFull: refund
      ? Math.abs(Number(refund.amount != null ? refund.amount : order.totalAmount) - Number(refund.paidAmount != null ? refund.paidAmount : order.totalAmount)) < 0.005
      : false,
    refundAtLabel: refund ? formatDatetime(refund.at) : '',
    refundId: refund && refund.id ? String(refund.id) : '',
  };
}

function buildReceiptPdf({ eventInfo, receipt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const left = 56;
    const contentW = W - left * 2;

    doc.rect(0, 0, W, 120).fill(BLACK);
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(28).text(eventInfo.name, 0, 34, { width: W, align: 'center' });
    doc.fillColor('#ffffff').font('Helvetica').fontSize(11)
      .text(`${eventInfo.dateLabel}  -  ${eventInfo.venue}`, 0, 74, { width: W, align: 'center' });

    let y = 152;
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(18)
      .text('Comprovante de cancelamento e reembolso', left, y, { width: contentW });
    y += 30;
    doc.fillColor(DIM).font('Helvetica').fontSize(10)
      .text(`Protocolo ${receipt.protocol}  |  Emitido em ${receipt.cancelledAtLabel}`, left, y, { width: contentW });
    y += 34;

    function section(title) {
      doc.moveTo(left, y).lineTo(left + contentW, y).strokeColor(GOLD).lineWidth(1).stroke();
      y += 10;
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), left, y, { width: contentW });
      y += 22;
    }

    function row(label, value) {
      if (!value) return;
      doc.fillColor(DIM).font('Helvetica').fontSize(10).text(label, left, y, { width: 150 });
      doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10).text(value, left + 160, y, { width: contentW - 160 });
      y += Math.max(18, doc.heightOfString(value, { width: contentW - 160 }) + 6);
    }

    section('Comprador');
    row('Nome', receipt.buyerName);
    row('CPF', receipt.buyerCpfMasked);
    row('E-mail', receipt.buyerEmail);
    y += 10;

    section('Pedido');
    row('Lote', receipt.loteName);
    row('Quantidade', `${receipt.quantity} ingresso${receipt.quantity === 1 ? '' : 's'}`);
    row('Valor pago', receipt.totalLabel);
    row('Forma de pagamento', receipt.paymentLabel);
    row('Data da compra', receipt.purchasedAtLabel);
    row('ID do pagamento', receipt.mpPaymentId);
    row('Ingressos cancelados', receipt.ticketCodes.join(', '));
    y += 10;

    section('Cancelamento e reembolso');
    row('Cancelado em', receipt.cancelledAtLabel);
    row('Situação', receipt.refundTitle);
    row('Valor reembolsado', receipt.refundAmountLabel + (receipt.refundIsFull ? ' (integral)' : ''));
    row('Data do reembolso', receipt.refundAtLabel);
    row('ID do reembolso', receipt.refundId);
    y += 6;
    doc.fillColor(DIM).font('Helvetica').fontSize(10).text(receipt.refundNote, left, y, { width: contentW, lineGap: 3 });
    y += doc.heightOfString(receipt.refundNote, { width: contentW, lineGap: 3 }) + 24;

    doc.fillColor(DIM).font('Helvetica').fontSize(9).text(
      'Os ingressos listados acima foram cancelados e não são mais válidos para entrada no evento. ' +
        'Guarde este comprovante. Em caso de dúvida, responda o e-mail em que o recebeu ou fale com a organização.',
      left, y, { width: contentW, lineGap: 3 }
    );
    y += 52;

    const days = process.env.REFUND_DAYS || 7;
    const policyHost = String(process.env.BASE_URL || 'crewolada.com').replace(/^https?:\/\//, '');
    doc.moveTo(left, y).lineTo(left + contentW, y).strokeColor('#cccccc').lineWidth(0.5).stroke();
    y += 10;
    doc.fillColor(DIM).font('Helvetica-Bold').fontSize(8).text('Política de cancelamento e reembolso', left, y, { width: contentW });
    y += 14;
    doc.fillColor(DIM).font('Helvetica').fontSize(8).text(
      `Direito de arrependimento: a compra pode ser cancelada em até ${days} dias corridos contados da data da compra, ` +
        'com reembolso integral do valor pago, conforme o art. 49 do Código de Defesa do Consumidor (Lei 8.078/1990). ' +
        `Regras completas em ${policyHost}/politica-de-cancelamento.`,
      left, y, { width: contentW, lineGap: 2 }
    );

    doc.end();
  });
}

function buildReceiptMessage({ order, receipt, receiptUrl }) {
  const refundLine = receipt.hasRefund
    ? ` e o reembolso de ${receipt.refundAmountLabel} foi realizado`
    : '';
  return (
    `Oi ${order.buyerName}! Seu pedido na Crewolada foi cancelado${refundLine}. O comprovante segue em anexo.\n\n` +
    `Protocolo: ${receipt.protocol}\n` +
    `Comprovante online: ${receiptUrl}\n\n` +
    `${receipt.refundNote}`
  );
}

function receiptUrlFor(order) {
  return `${process.env.BASE_URL}/comprovante/${order.id}`;
}

// wa.me link the ADMIN opens in their own WhatsApp (same approach as the
// ticket resend button — bypasses the unreliable Evolution API session).
function buildAdminWhatsappReceiptLink(order, formatDatetime) {
  const db = store.load();
  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  const receipt = buildReceipt(order, tickets, formatDatetime);
  const phone = normalizePhone(order.buyerPhone);
  const mensagem = buildReceiptMessage({ order, receipt, receiptUrl: receiptUrlFor(order) });
  return `https://wa.me/${phone}?text=${encodeURIComponent(mensagem)}`;
}

// Tells the customer their order was cancelled (and refunded, if so) with the
// receipt PDF attached, through the same n8n webhook that delivers tickets.
// `channel` is 'email', 'whatsapp' or 'both'. Throws if it can't be sent, so
// callers decide whether that's fatal (the cancel itself never is).
async function sendReceiptNotification(orderId, { eventInfo, formatDatetime, channel = 'both' }) {
  const db = store.load();
  const order = db.orders[orderId];
  if (!order || order.status !== 'cancelled') throw new Error('Este pedido não está cancelado.');

  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('N8N_WEBHOOK_URL não configurada.');

  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  const receipt = buildReceipt(order, tickets, formatDatetime);
  const pdf = await buildReceiptPdf({ eventInfo, receipt });

  await axios.post(
    webhookUrl,
    {
      nome: order.buyerName,
      email: order.buyerEmail,
      nomeLote: order.loteName,
      codigo: receipt.protocol,
      numeroSorteio: '',
      whatsapp: normalizePhone(order.buyerPhone),
      pdfBase64: pdf.toString('base64'),
      fileName: `comprovante-${receipt.protocol}.pdf`,
      mensagemPersonalizada: buildReceiptMessage({ order, receipt, receiptUrl: receiptUrlFor(order) }),
      assunto: `Comprovante de cancelamento${receipt.hasRefund ? ' e reembolso' : ''} - ${eventInfo.name} 2026`,
      origem: 'comprovante',
      canal: channel,
    },
    { timeout: 15000 }
  );

  await store.withDb((d) => {
    const o = d.orders[order.id];
    if (!o) return;
    o.receiptSentAt = new Date().toISOString();
    o.receiptSentChannel = channel;
  });
}

function registerComprovanteRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay }) {
  function loadReceipt(orderId) {
    const db = store.load();
    const order = db.orders[orderId];
    if (!order || order.status !== 'cancelled') return null;
    const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
    return { order, receipt: buildReceipt(order, tickets, formatDatetimeBrasiliaDisplay) };
  }

  app.get('/comprovante/:id', (req, res) => {
    const found = loadReceipt(req.params.id);
    if (!found) return res.status(404).send('Comprovante não encontrado.');
    return res.render('comprovante', { eventInfo, receipt: found.receipt });
  });

  app.get('/comprovante/:id/pdf', async (req, res) => {
    const found = loadReceipt(req.params.id);
    if (!found) return res.status(404).send('Comprovante não encontrado.');
    const buffer = await buildReceiptPdf({ eventInfo, receipt: found.receipt });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="comprovante-${found.receipt.protocol}.pdf"`);
    return res.send(buffer);
  });

  // Sends the receipt to the customer by e-mail (and/or WhatsApp) through the
  // same n8n webhook that delivers tickets, with the PDF attached.
  app.post('/api/admin/pedidos/:id/comprovante/enviar', requireAdminAuth, async (req, res) => {
    if (!loadReceipt(req.params.id)) return res.status(400).json({ error: 'Este pedido não está cancelado.' });
    const canal = ['email', 'whatsapp', 'both'].includes(req.body.canal) ? req.body.canal : 'email';

    try {
      await sendReceiptNotification(req.params.id, {
        eventInfo,
        formatDatetime: formatDatetimeBrasiliaDisplay,
        channel: canal,
      });
    } catch (err) {
      console.error(`Erro ao enviar comprovante do pedido ${req.params.id}:`, err.message);
      return res.status(502).json({ error: 'Não foi possível enviar o comprovante agora. Tente novamente.' });
    }

    return res.json({ ok: true });
  });
}

module.exports = {
  registerComprovanteRoutes,
  buildAdminWhatsappReceiptLink,
  sendReceiptNotification,
};
