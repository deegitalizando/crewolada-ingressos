require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const store = require('./store');
const mp = require('./mercadopago');
const { getCurrentLote } = require('./lotes');
const { approveOrder } = require('./fulfillment');
const { isValidCpf } = require('./cpf');
const { sendBroadcast } = require('./n8n');
const { getTemplates } = require('./templates');
const { startReminderScheduler } = require('./reminders');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const eventInfo = {
  name: process.env.EVENT_NAME || 'Crewolada',
  dateLabel: process.env.EVENT_DATE_LABEL || '10/10/2026',
  venue: process.env.EVENT_VENUE || 'Bangu Atletico Clube',
};
const maxQty = Number(process.env.MAX_QTY_PER_ORDER || 10);

const REJECTION_MESSAGES = {
  cc_rejected_insufficient_amount: 'Saldo/limite insuficiente no cartao.',
  cc_rejected_bad_filled_security_code: 'Codigo de seguranca (CVV) incorreto.',
  cc_rejected_bad_filled_date: 'Data de validade incorreta.',
  cc_rejected_bad_filled_other: 'Dados do cartao incorretos. Confira e tente novamente.',
  cc_rejected_call_for_authorize: 'Pagamento nao autorizado pelo banco. Entre em contato com seu banco.',
  cc_rejected_card_disabled: 'Cartao desabilitado. Ligue para o banco para ativa-lo.',
  cc_rejected_duplicated_payment: 'Ja existe um pagamento igual. Se precisar, use outro cartao.',
  cc_rejected_high_risk: 'Pagamento recusado por seguranca. Tente outro meio de pagamento.',
  cc_rejected_max_attempts: 'Numero maximo de tentativas atingido. Tente outro cartao.',
};

function describeRejection(statusDetail) {
  return REJECTION_MESSAGES[statusDetail] || 'Pagamento recusado. Tente outro cartao ou meio de pagamento.';
}

function getSoldCount(db) {
  return Object.keys(db.tickets).length;
}

// ---- validator auth (in-memory sessions, reset on server restart) ----
const validatorSessions = new Set();

function requireValidatorAuth(req, res, next) {
  const token = req.cookies.validator_session;
  if (token && validatorSessions.has(token)) return next();
  return res.redirect('/validador');
}

// ---- admin/sales panel auth (in-memory sessions, reset on server restart) ----
const adminSessions = new Set();

function requireAdminAuth(req, res, next) {
  const token = req.cookies.admin_session;
  if (token && adminSessions.has(token)) return next();
  return res.redirect('/vendas');
}

// ---------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------

app.get('/', (req, res) => {
  const db = store.load();
  const lote = getCurrentLote(getSoldCount(db));
  res.render('index', { eventInfo, lote, maxQty, error: null });
});

const LEGAL_UPDATED_AT = '26/08/2026';

app.get('/politica-de-privacidade', (req, res) => {
  res.render('privacidade', { eventInfo, updatedAt: LEGAL_UPDATED_AT });
});

app.get('/termos-de-uso', (req, res) => {
  res.render('termos', { eventInfo, updatedAt: LEGAL_UPDATED_AT });
});

app.get('/checkout/dados', (req, res) => {
  const db = store.load();
  const lote = getCurrentLote(getSoldCount(db));
  if (!lote) return res.redirect('/');

  const qty = Math.min(Math.max(parseInt(req.query.qty, 10) || 1, 1), Math.min(lote.remaining, maxQty));
  res.render('checkout_dados', {
    eventInfo,
    quantity: qty,
    loteName: lote.name,
    total: Number((lote.price * qty).toFixed(2)),
    mpPublicKey: process.env.MP_PUBLIC_KEY,
  });
});

app.post('/api/pagamentos', async (req, res) => {
  try {
    const { buyerName, buyerEmail, buyerPhone, buyerCpf, quantity, formData } = req.body;

    if (!buyerName || !buyerEmail || !buyerPhone || !buyerCpf || !formData) {
      return res.status(400).json({ error: 'Preencha nome, e-mail, WhatsApp e CPF para continuar.' });
    }
    if (!isValidCpf(buyerCpf)) {
      return res.status(400).json({ error: 'CPF invalido. Confira e tente novamente.' });
    }

    const db = store.load();
    const lote = getCurrentLote(getSoldCount(db));
    if (!lote) {
      return res.status(400).json({ error: 'Os ingressos deste lote se esgotaram.' });
    }

    const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), Math.min(lote.remaining, maxQty));

    const order = {
      id: crypto.randomUUID(),
      buyerName,
      buyerEmail,
      buyerPhone,
      buyerCpf: String(buyerCpf).replace(/\D/g, ''),
      quantity: qty,
      loteName: lote.name,
      unitPrice: lote.price,
      totalAmount: Number((lote.price * qty).toFixed(2)),
      status: 'pending',
      mpPaymentId: null,
      paymentMethodId: formData.payment_method_id || null,
      pixQrCode: null,
      pixQrCodeBase64: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const payment = await mp.createPayment(order, formData);
    order.mpPaymentId = String(payment.id);

    if (payment.status === 'rejected') {
      await store.withDb((d) => {
        d.orders[order.id] = { ...order, status: 'rejected' };
      });
      return res.status(400).json({ error: describeRejection(payment.status_detail) });
    }

    const qrData = payment.point_of_interaction?.transaction_data;
    if (qrData) {
      order.pixQrCode = qrData.qr_code || null;
      order.pixQrCodeBase64 = qrData.qr_code_base64 || null;
    }

    await store.withDb((d) => {
      d.orders[order.id] = order;
    });

    if (payment.status === 'approved') {
      await approveOrder(order.id, payment.id, eventInfo);
    }

    return res.json({ redirectUrl: `/pedido/${order.id}` });
  } catch (err) {
    console.error('Erro ao criar pagamento Mercado Pago:', err.message);
    return res.status(500).json({ error: 'Nao foi possivel processar o pagamento. Tente novamente.' });
  }
});

app.get('/pedido/:id', (req, res) => {
  const db = store.load();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).send('Pedido nao encontrado.');

  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  res.render('order_status', { eventInfo, order, tickets });
});

app.get('/api/pedido/:id/status', (req, res) => {
  const db = store.load();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'not_found' });

  const tickets = Object.values(db.tickets)
    .filter((t) => t.orderId === order.id)
    .map((t) => ({ code: t.code }));

  res.json({ status: order.status, tickets });
});

app.get('/ingresso/:code', (req, res) => {
  const db = store.load();
  const ticket = db.tickets[req.params.code];
  if (!ticket) return res.status(404).send('Ingresso nao encontrado.');

  const order = db.orders[ticket.orderId];
  res.render('ticket', { eventInfo, ticket, order });
});

app.get('/ingresso/:code/pdf', (req, res) => {
  const db = store.load();
  const ticket = db.tickets[req.params.code];
  if (!ticket || !ticket.pdfBase64) return res.status(404).send('Ingresso nao encontrado.');

  const buffer = Buffer.from(ticket.pdfBase64, 'base64');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="ingresso-${ticket.code}.pdf"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------
// Mercado Pago webhook (Pix/boleto e confirmacoes assincronas de cartao)
// ---------------------------------------------------------------------

app.post('/api/webhooks/mercadopago', async (req, res) => {
  try {
    const type = req.query.type || req.body.type || req.query.topic;
    const dataId = req.query['data.id'] || req.body?.data?.id || req.query.id;

    if (type !== 'payment' || !dataId) {
      return res.sendStatus(200);
    }

    const validSignature = mp.isValidWebhookSignature({
      xSignature: req.headers['x-signature'],
      xRequestId: req.headers['x-request-id'],
      dataId,
    });
    if (!validSignature) {
      console.warn('Assinatura de webhook invalida, ignorando.');
      return res.sendStatus(401);
    }

    const payment = await mp.getPayment(dataId);
    const orderId = payment.external_reference;
    if (!orderId) return res.sendStatus(200);

    if (payment.status !== 'approved') {
      return res.sendStatus(200);
    }

    await approveOrder(orderId, dataId, eventInfo);

    return res.sendStatus(200);
  } catch (err) {
    console.error('Erro processando webhook Mercado Pago:', err.message);
    return res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------
// Validador de ingressos
// ---------------------------------------------------------------------

app.get('/validador', (req, res) => {
  const token = req.cookies.validator_session;
  if (token && validatorSessions.has(token)) {
    return res.render('validator', { eventInfo });
  }
  res.render('validator_login', { error: null });
});

app.post('/validador/login', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.VALIDATOR_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    validatorSessions.add(token);
    res.cookie('validator_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return res.redirect('/validador');
  }
  return res.status(401).render('validator_login', { error: 'Senha incorreta.' });
});

app.post('/validador/logout', (req, res) => {
  const token = req.cookies.validator_session;
  if (token) validatorSessions.delete(token);
  res.clearCookie('validator_session');
  res.redirect('/validador');
});

app.post('/api/validar', requireValidatorAuth, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const db = store.load();
  const ticket = db.tickets[code];

  if (!ticket) {
    return res.json({ result: 'invalido', message: 'Ingresso nao encontrado.' });
  }

  if (ticket.status === 'used') {
    return res.json({
      result: 'ja_usado',
      message: `Ingresso ja utilizado em ${new Date(ticket.usedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
      code: ticket.code,
      usedAt: ticket.usedAt,
    });
  }

  const order = db.orders[ticket.orderId];
  const usedAt = new Date().toISOString();

  await store.withDb((d) => {
    const t = d.tickets[code];
    if (t && t.status !== 'used') {
      t.status = 'used';
      t.usedAt = usedAt;
    }
  });

  return res.json({
    result: 'valido',
    message: 'Ingresso valido. Entrada liberada!',
    code: ticket.code,
    buyerName: order?.buyerName || '',
    usedAt,
  });
});

// ---------------------------------------------------------------------
// Painel de vendas
// ---------------------------------------------------------------------

app.get('/vendas', (req, res) => {
  const token = req.cookies.admin_session;
  if (!token || !adminSessions.has(token)) {
    return res.render('vendas_login', { eventInfo, error: null });
  }

  const db = store.load();
  const orders = Object.values(db.orders).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const stats = { totalRevenue: 0, ticketsSold: 0, paidOrders: 0 };
  const loteMap = {};

  orders.forEach((o) => {
    if (o.status !== 'paid') return;
    stats.totalRevenue += o.totalAmount;
    stats.ticketsSold += o.quantity;
    stats.paidOrders += 1;

    if (!loteMap[o.loteName]) loteMap[o.loteName] = { name: o.loteName, sold: 0, revenue: 0 };
    loteMap[o.loteName].sold += o.quantity;
    loteMap[o.loteName].revenue += o.totalAmount;
  });

  res.render('vendas', {
    eventInfo,
    stats,
    loteBreakdown: Object.values(loteMap),
    orders,
    broadcastConfigured: Boolean(process.env.N8N_BROADCAST_WEBHOOK_URL),
  });
});

app.post('/vendas/login', (req, res) => {
  const { login, password } = req.body;
  if (login === process.env.ADMIN_LOGIN && password === process.env.ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.add(token);
    res.cookie('admin_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return res.redirect('/vendas');
  }
  return res.status(401).render('vendas_login', { eventInfo, error: 'Login ou senha incorretos.' });
});

app.post('/vendas/logout', (req, res) => {
  const token = req.cookies.admin_session;
  if (token) adminSessions.delete(token);
  res.clearCookie('admin_session');
  res.redirect('/vendas');
});

app.post('/api/vendas/broadcast', requireAdminAuth, async (req, res) => {
  const mensagem = String(req.body.mensagem || '').trim();
  if (!mensagem) {
    return res.status(400).json({ error: 'Mensagem vazia.' });
  }
  try {
    await sendBroadcast(mensagem);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao disparar broadcast:', err.message);
    return res.status(500).json({ error: 'Nao foi possivel enviar. Confira a configuracao do n8n.' });
  }
});

app.get('/vendas/mensagens', requireAdminAuth, (req, res) => {
  const db = store.load();
  let eventStartAtLocal = '';
  if (db.eventStartAt) {
    const d = new Date(db.eventStartAt);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type).value;
    eventStartAtLocal = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  }

  res.render('vendas_mensagens', {
    eventInfo,
    templates: getTemplates(db),
    eventStartAtLocal,
    remindersSent: db.remindersSent || {},
    saved: req.query.saved === '1',
  });
});

app.post('/api/vendas/mensagens', requireAdminAuth, async (req, res) => {
  const { compra, dias5, dia1, diaEvento, hora1, eventStartAt } = req.body;
  await store.withDb((db) => {
    db.messageTemplates = { compra, dias5, dia1, diaEvento, hora1 };
    // datetime-local has no offset; treat it as Brasilia time explicitly so
    // the reminder schedule doesn't shift with the server's own OS timezone.
    if (eventStartAt) db.eventStartAt = new Date(`${eventStartAt}:00-03:00`).toISOString();
  });
  res.redirect('/vendas/mensagens?saved=1');
});

app.listen(PORT, () => {
  console.log(`Crewolada rodando em http://localhost:${PORT}`);
  startReminderScheduler();
});
