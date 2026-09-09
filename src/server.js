require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const store = require('./store');
const mp = require('./mercadopago');
const { getLotes, getCurrentLote, getSoldOutLotes } = require('./lotes');

// Once a lote has this many tickets or fewer left, the sales page starts
// showing "restam X ingressos" as an urgency nudge. Above that, the exact
// count stays hidden.
const LOW_STOCK_THRESHOLD = 49;

// The exact phrase the "Receber no WhatsApp" button pre-fills — the n8n
// workflow matches on this same text to know the buyer wants their ticket
// resent (as opposed to a general question for the AI to answer).
const WHATSAPP_TICKET_TRIGGER_TEXT = 'Quero receber meu ingresso da Crewolada 🎟️';

function buildWhatsappTicketLink() {
  const ddi = process.env.DEFAULT_COUNTRY_CODE || '55';
  const rawNumber = (process.env.BUSINESS_WHATSAPP_NUMBER || '2139557816').replace(/\D/g, '');
  const number = rawNumber.startsWith(ddi) ? rawNumber : `${ddi}${rawNumber}`;
  return `https://wa.me/${number}?text=${encodeURIComponent(WHATSAPP_TICKET_TRIGGER_TEXT)}`;
}
const { approveOrder } = require('./fulfillment');
const { isValidCpf } = require('./cpf');
const { sendBroadcast, notifyOrderApproved } = require('./n8n');
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

// Tickets sold under "Lote Teste" don't count toward real lote inventory —
// those buyers keep their valid tickets, they just don't eat into the real
// launch's 1o Lote allotment.
function getSoldCount(db) {
  return Object.values(db.tickets).filter((t) => {
    const order = db.orders[t.orderId];
    return !order || order.loteName !== 'Lote Teste';
  }).length;
}

function formatDatetimeLocalBrasilia(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
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
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

// datetime-local has no offset; treat it as Brasilia time explicitly so the
// schedule doesn't shift depending on the server's own OS timezone.
function parseDatetimeLocalAsBrasilia(datetimeLocal) {
  return new Date(`${datetimeLocal}:00-03:00`).toISOString();
}

// dd/mm/yyyy hh:mm, explicitly in Brasilia time, for display in the admin
// panel (independent of the server's own OS timezone, usually UTC).
function formatDatetimeBrasiliaDisplay(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

// ---- validator auth (in-memory sessions, reset on server restart) ----
const validatorSessions = new Set();

function requireValidatorAuth(req, res, next) {
  const token = req.cookies.validator_session;
  if (token && validatorSessions.has(token)) return next();
  return res.redirect('/validador');
}

// ---- admin panel auth (in-memory sessions, reset on server restart) ----
const adminSessions = new Set();

function requireAdminAuth(req, res, next) {
  const token = req.cookies.admin_session;
  if (token && adminSessions.has(token)) return next();
  return res.redirect('/admin');
}

// ---------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------

app.get('/', (req, res) => {
  const db = store.load();
  const lotes = getLotes(db);
  const soldCount = getSoldCount(db);
  const lote = getCurrentLote(lotes, soldCount);
  const soldOutLotes = getSoldOutLotes(lotes, soldCount);
  res.render('index', { eventInfo, lote, maxQty, error: null, soldOutLotes, lowStockThreshold: LOW_STOCK_THRESHOLD });
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
  const lote = getCurrentLote(getLotes(db), getSoldCount(db));
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
    const lote = getCurrentLote(getLotes(db), getSoldCount(db));
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
  res.render('order_status', { eventInfo, order, tickets, whatsappTicketLink: buildWhatsappTicketLink() });
});

app.get('/pedido/:id/participantes', (req, res) => {
  const db = store.load();
  const order = db.orders[req.params.id];
  if (!order || order.status !== 'paid') return res.status(404).send('Pedido nao encontrado.');

  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  res.render('participantes', { eventInfo, order, tickets, saved: req.query.saved === '1' });
});

app.post('/api/pedido/:id/participantes', async (req, res) => {
  const db = store.load();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).send('Pedido nao encontrado.');

  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  const submitted = req.body.participantes || {};

  await store.withDb((d) => {
    tickets.forEach((t) => {
      const p = submitted[t.code];
      const ticket = d.tickets[t.code];
      if (!p || !ticket) return;
      ticket.participantName = String(p.name || '').trim() || null;
      ticket.participantEmail = String(p.email || '').trim() || null;
      ticket.participantPhone = String(p.phone || '').trim() || null;
    });
  });

  res.redirect(`/pedido/${order.id}/participantes?saved=1`);
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
// Painel administrativo (/admin)
// ---------------------------------------------------------------------

// Backward-compatible redirects from the old /vendas paths.
app.get('/vendas', (req, res) => res.redirect('/admin'));
app.get('/vendas/mensagens', (req, res) => res.redirect('/admin/mensagens'));

app.get('/admin', (req, res) => {
  const token = req.cookies.admin_session;
  if (!token || !adminSessions.has(token)) {
    return res.render('admin_login', { eventInfo, error: null });
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

  const ordersWithDate = orders.map((o) => ({
    ...o,
    createdAtLabel: formatDatetimeBrasiliaDisplay(o.createdAt),
  }));

  res.render('admin_dashboard', {
    eventInfo,
    stats,
    loteBreakdown: Object.values(loteMap),
    orders: ordersWithDate,
    broadcastConfigured: Boolean(process.env.N8N_BROADCAST_WEBHOOK_URL),
  });
});

app.post('/admin/login', (req, res) => {
  const { login, password } = req.body;
  if (login === process.env.ADMIN_LOGIN && password === process.env.ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.add(token);
    res.cookie('admin_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return res.redirect('/admin');
  }
  return res.status(401).render('admin_login', { eventInfo, error: 'Login ou senha incorretos.' });
});

app.post('/admin/logout', (req, res) => {
  const token = req.cookies.admin_session;
  if (token) adminSessions.delete(token);
  res.clearCookie('admin_session');
  res.redirect('/admin');
});

app.post('/api/admin/broadcast', requireAdminAuth, async (req, res) => {
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

app.post('/api/admin/pedidos/:id/reenviar', requireAdminAuth, async (req, res) => {
  const db = store.load();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  if (order.status !== 'paid') return res.status(400).json({ error: 'Este pedido ainda nao foi pago.' });

  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  if (tickets.length === 0) return res.status(400).json({ error: 'Nenhum ingresso encontrado para este pedido.' });

  const canal = ['email', 'whatsapp', 'both'].includes(req.body.canal) ? req.body.canal : 'both';

  try {
    await notifyOrderApproved(order, tickets, { origin: 'reenvio', channel: canal });
    return res.json({ ok: true });
  } catch (err) {
    console.error(`Erro ao reenviar pedido ${order.id}:`, err.message);
    return res.status(500).json({ error: 'Nao foi possivel reenviar. Tente novamente.' });
  }
});

// Called by n8n when a customer messages the WhatsApp number asking for their
// ticket. Looks up the most recent paid order for that phone number and, if
// found, resends it (WhatsApp + e-mail) — this is a reply within a
// conversation the customer started, so it doesn't risk the number being
// flagged for cold-starting conversations the way the automatic post-purchase
// send would.
app.post('/api/n8n/ingresso-por-telefone', async (req, res) => {
  const secret = process.env.N8N_CALLBACK_SECRET;
  if (secret && req.headers['x-callback-secret'] !== secret) {
    return res.status(401).json({ found: false, error: 'unauthorized' });
  }

  const phone = String(req.body.telefone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ found: false });

  const normalize = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const targetSuffix = normalize(phone);

  const db = store.load();
  const matchingOrders = Object.values(db.orders)
    .filter((o) => o.status === 'paid' && normalize(o.buyerPhone) === targetSuffix)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (matchingOrders.length === 0) return res.json({ found: false });

  const order = matchingOrders[0];
  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  if (tickets.length === 0) return res.json({ found: false });

  try {
    await notifyOrderApproved(order, tickets, { origin: 'reenvio' });
    return res.json({ found: true, buyerName: order.buyerName });
  } catch (err) {
    console.error(`Erro ao reenviar ingresso por telefone (pedido ${order.id}):`, err.message);
    return res.status(500).json({ found: false, error: 'send_failed' });
  }
});

app.get('/admin/lotes', requireAdminAuth, (req, res) => {
  const db = store.load();
  const lotes = getLotes(db);
  const soldCount = getSoldCount(db);
  res.render('admin_lotes', { eventInfo, lotes, soldCount, saved: req.query.saved === '1' });
});

app.post('/api/admin/lotes', requireAdminAuth, async (req, res) => {
  const raw = req.body.lotes || {};
  const lotes = Object.values(raw)
    .map((l) => ({
      name: String(l.name || '').trim(),
      quantity: Math.max(0, parseInt(l.quantity, 10) || 0),
      price: Math.max(0, Number(l.price) || 0),
    }))
    .filter((l) => l.name && l.quantity > 0);

  if (lotes.length === 0) {
    return res.status(400).send('Cadastre pelo menos um lote valido.');
  }

  await store.withDb((db) => {
    db.lotes = lotes;
  });

  res.redirect('/admin/lotes?saved=1');
});

app.get('/admin/mensagens', requireAdminAuth, (req, res) => {
  const db = store.load();
  const campaigns = (db.campaigns || []).slice().sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));

  res.render('admin_mensagens', {
    eventInfo,
    templates: getTemplates(db),
    eventStartAtLocal: formatDatetimeLocalBrasilia(db.eventStartAt),
    remindersSent: db.remindersSent || {},
    campaigns: campaigns.map((c) => ({ ...c, sendAtLocal: formatDatetimeLocalBrasilia(c.sendAt) })),
    saved: req.query.saved === '1',
  });
});

app.post('/api/admin/mensagens', requireAdminAuth, async (req, res) => {
  const { compra, dias5, dia1, diaEvento, hora1, eventStartAt } = req.body;
  await store.withDb((db) => {
    db.messageTemplates = { compra, dias5, dia1, diaEvento, hora1 };
    if (eventStartAt) db.eventStartAt = parseDatetimeLocalAsBrasilia(eventStartAt);
  });
  res.redirect('/admin/mensagens?saved=1');
});

app.post('/api/admin/campanhas', requireAdminAuth, async (req, res) => {
  const mensagem = String(req.body.mensagem || '').trim();
  const sendAtLocal = req.body.sendAt;
  if (!mensagem || !sendAtLocal) {
    return res.redirect('/admin/mensagens');
  }

  const campaign = {
    id: crypto.randomUUID(),
    mensagem,
    sendAt: parseDatetimeLocalAsBrasilia(sendAtLocal),
    sent: false,
    createdAt: new Date().toISOString(),
  };

  await store.withDb((db) => {
    db.campaigns = db.campaigns || [];
    db.campaigns.push(campaign);
  });

  res.redirect('/admin/mensagens?saved=1');
});

app.post('/api/admin/campanhas/:id/excluir', requireAdminAuth, async (req, res) => {
  await store.withDb((db) => {
    db.campaigns = (db.campaigns || []).filter((c) => c.id !== req.params.id);
  });
  res.redirect('/admin/mensagens?saved=1');
});

app.listen(PORT, () => {
  console.log(`Crewolada rodando em http://localhost:${PORT}`);
  startReminderScheduler();
});
