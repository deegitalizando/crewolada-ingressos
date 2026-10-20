require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const store = require('./store');
const mp = require('./mercadopago');
const { getLotes, getCurrentLote, getSoldOutLotes } = require('./lotes');
const { currentEvent, LEGACY_EVENT, EVENTS, inEvent, eventForOrder, eventStatus, syncEvents, getEventById, salesOpensAt, salesHeldBack } = require('./event');
const { registerEventosRoutes } = require('./eventos');
const { registerContatoRoutes } = require('./contato');
const { registerLinksRoutes } = require('./links');
const { registerAfiliadosRoutes } = require('./afiliados');
const { registerPushRoutes } = require('./push');
const { getProducts, getChildRules, buildPurchase } = require('./produtos');

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
const { registerCortesiaRoutes } = require('./cortesia');
const { registerContabilidadeRoutes } = require('./contabilidade');
const { registerRelatorioRoutes } = require('./relatorio');
const { registerPesquisaRoutes } = require('./pesquisa');
const { registerComprovanteRoutes, buildAdminWhatsappReceiptLink, sendReceiptNotification } = require('./comprovante');
const { isValidCpf } = require('./cpf');
const { sendBroadcast, notifyOrderApproved, normalizePhone } = require('./n8n');
const {
  criarPedidoMusica, aprovarPedidoMusica, marcarMusicaPronta, posEntregaMusica, buscarPedidoPorCodigo, codigoCurto,
  registerMusicaPersonalizadaRoutes, validarLetraCrista, PRECO: PRECO_MUSICA,
} = require('./musicaPersonalizada');

// Builds a wa.me link, pre-filled with the ticket link, that the ADMIN opens
// in their own WhatsApp to resend a ticket by hand. This bypasses the
// Evolution API/Baileys automation entirely (unreliable when that WhatsApp
// session is unstable) since it's the admin's own client sending the
// message — the admin still has to tap "send" themselves.
function buildAdminWhatsappResendLink(order) {
  const phone = normalizePhone(order.buyerPhone);
  const ticketUrl = `${process.env.BASE_URL}/pedido/${order.id}`;
  const mensagem = `Oi ${order.buyerName}! Aqui esta o link do seu ingresso da Crewolada 🎟️\n${ticketUrl}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(mensagem)}`;
}
const { getTemplates } = require('./templates');
const { startReminderScheduler } = require('./reminders');
const { startMusicaFollowUpScheduler } = require('./musicaFollowUps');
const musicas = require('./musicas');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Admin pages get the installable-app tags (manifest, "Crew Admin" icon) in views/partials/head.ejs.
app.use((req, res, next) => {
  res.locals.adminPage = /^\/(admin|contabilidade|downloads|validador)/.test(req.path);
  next();
});

// Available to every view without needing to be passed into each res.render()
// call individually.
app.locals.metaPixelId = process.env.FACEBOOK_PIXEL_ID || '';

// Consumer-facing contact + seller details shown in the legal footer and the
// cancellation policy. SELLER_DOCUMENT / SELLER_ADDRESS are optional and only
// rendered when set.
// Sales are open for the current event. SALES_OPEN=false closes them (the home
// then shows the thank-you page and /checkout is blocked), e.g. after the event.
app.locals.salesOpen = process.env.SALES_OPEN !== 'false';

// Sales also stay closed while the current event has a future salesOpenAt ("Em breve").
const salesOpenNow = () => app.locals.salesOpen && !salesHeldBack(currentEvent);
function opensLabelBR(ts) {
  const tz = 'America/Sao_Paulo';
  const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).formatToParts(new Date(ts));
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  const hm = g('minute') === '00' ? `${Number(g('hour'))}h` : `${Number(g('hour'))}h${g('minute')}`;
  const now = Date.now();
  if (day(ts) === day(now)) return `hoje às ${hm}`;
  if (day(ts) === day(now + 86400000)) return `amanhã às ${hm}`;
  return `${g('day')}/${g('month')} às ${hm}`;
}
app.locals.communityUrl = process.env.COMMUNITY_URL || 'https://chat.whatsapp.com/IfH31ObCm3o66OHOM46oup';
const REFUND_DAYS = Number(process.env.REFUND_DAYS || 7);
app.locals.refundDays = REFUND_DAYS;
{
  const ddi = process.env.DEFAULT_COUNTRY_CODE || '55';
  const digits = (process.env.BUSINESS_WHATSAPP_NUMBER || '2139557816').replace(/\D/g, '');
  const local = digits.startsWith(ddi) && digits.length > 11 ? digits.slice(ddi.length) : digits;
  const label = local.length === 11
    ? `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`
    : `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  const text = 'Olá! Quero solicitar o cancelamento e reembolso da minha compra na Crewolada.';
  app.locals.contact = {
    whatsappUrl: `https://wa.me/${ddi}${local}?text=${encodeURIComponent(text)}`,
    whatsappLabel: label,
    email: process.env.CONTACT_EMAIL || 'contato@crewolada.com',
    sellerName: process.env.SELLER_NAME || 'Diego Carreiro Moura',
    sellerDocument: process.env.SELLER_DOCUMENT || '',
    sellerAddress: process.env.SELLER_ADDRESS || '',
  };
}

// The current event (src/event.js). Pages about an older order use that
// order's own event through eventInfoFor(), so old tickets keep their data.
const eventInfo = {
  id: currentEvent.id,
  name: currentEvent.name,
  brand: currentEvent.brand,
  dateLabel: currentEvent.dateLabel,
  timeLabel: currentEvent.timeLabel,
  venue: currentEvent.venue,
  startAt: currentEvent.startAt,
  capacity: currentEvent.capacity || null,
};
const eventInfoFor = (order) => ({ ...eventInfo, ...eventForOrder(order) });

// Re-read the current event after the admin changes events or switches the
// one on sale. Single process, so memory is always up to date.
function refreshEvents() {
  syncEvents(store.load());
  Object.assign(eventInfo, {
    id: currentEvent.id,
    name: currentEvent.name,
    brand: currentEvent.brand,
    dateLabel: currentEvent.dateLabel,
    timeLabel: currentEvent.timeLabel,
    venue: currentEvent.venue,
    startAt: currentEvent.startAt,
    capacity: currentEvent.capacity || null,
  });
}
refreshEvents();

const statusLabels = { atual: 'atual', anterior: 'anterior', futuro: 'futuro' };
// Events offered in the dashboard/report switcher: current + any with orders.
function eventsForSwitcher(db) {
  return EVENTS
    .filter((e) => e.id === currentEvent.id || Object.values(db.orders || {}).some((o) => inEvent(o, e.id)))
    .map((e) => ({ id: e.id, name: e.name, dateLabel: e.dateLabel, statusLabel: statusLabels[eventStatus(e)] }));
}

// cortesia.<dominio> serves the same app but only exposes the invite pages
// (and the assets/ticket views they link to) — never the sales page, checkout
// or admin, so courtesy guests can't stumble into the public storefront.
const CORTESIA_ALLOWED_PREFIXES = ['/c/', '/ingresso/', '/pedido/', '/meus-ingressos'];
app.use((req, res, next) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (!host.startsWith('cortesia.')) return next();
  if (CORTESIA_ALLOWED_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  return res.status(404).send('Link de convite invalido. Use o link que voce recebeu.');
});
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
// Courtesy tickets never count toward lote inventory either.
// Only tickets of the given event count toward its lote stock.
function getSoldCount(db, eventId = currentEvent.id) {
  return Object.values(db.tickets).filter((t) => {
    const order = db.orders[t.orderId];
    if (!order) return eventId === LEGACY_EVENT.id;
    if (!inEvent(order, eventId) || order.loteName === 'Lote Teste' || order.isCourtesy) return false;
    if (t.kind === 'bebe' && !getChildRules(getEventById(eventId)).freeCountsInCapacity) return false;
    return true;
  }).length;
}

// Seats of unpaid orders (Pix waiting, card in review) stay held for a while so that
// two buyers can never both get the last tickets. Free babies never hold a seat.
const HOLD_MS = 35 * 60 * 1000;
function payingSeats(order, rules) {
  if (Array.isArray(order.items)) {
    return order.items.reduce((sum, i) => sum + (i.kind === 'bebe' && !rules.freeCountsInCapacity ? 0 : i.qty), 0);
  }
  return order.quantity || 0;
}
function getHeldCount(db, eventId = currentEvent.id, now = Date.now()) {
  const rules = getChildRules(getEventById(eventId));
  return Object.values(db.orders || {})
    .filter((o) => o.status === 'pending' && !o.isCourtesy && o.loteName !== 'Lote Teste' && inEvent(o, eventId) && now - Date.parse(o.createdAt) < HOLD_MS)
    .reduce((sum, o) => sum + payingSeats(o, rules), 0);
}
// Tickets still on sale for a capacity-based (products) event.
function getAvailable(db, eventId = currentEvent.id) {
  const capacity = getEventById(eventId).capacity || 0;
  return Math.max(0, capacity - getSoldCount(db, eventId) - getHeldCount(db, eventId));
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

function isAdmin(req) {
  const token = req.cookies.admin_session;
  return Boolean(token && adminSessions.has(token));
}

function requireAdminAuth(req, res, next) {
  if (isAdmin(req)) return next();
  return res.redirect('/admin');
}

// ---------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------

// Affiliate programme (registered before the pages so a ?ref= link on any of them is counted).
registerAfiliadosRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay });
registerPushRoutes(app, { requireAdminAuth, eventInfo });

app.get('/', (req, res) => {
  if (!app.locals.salesOpen) return res.render('encerrado', { eventInfo });
  if (!salesOpenNow()) {
    const at = salesOpensAt(currentEvent);
    return res.render('em_breve', { eventInfo, total: currentEvent.capacity || 0, opensAtIso: new Date(at).toISOString(), opensLabel: opensLabelBR(at), communityUrl: app.locals.communityUrl });
  }
  const db = store.load();
  const lotes = getLotes(db);
  let soldCount = getSoldCount(db);
  let soldForView = soldCount;
  const products = getProducts(currentEvent);
  const productMode = products.length > 0;
  const capacity = currentEvent.capacity || 0;
  let lote = getCurrentLote(lotes, soldCount);
  let comingSoon = lotes.length === 0;
  let totalCapacity = lotes.reduce((sum, l) => sum + l.quantity, 0) || eventInfo.capacity || 0;
  if (productMode) {
    // Products replace lotes: availability is the event capacity minus what was sold.
    const remaining = getAvailable(db);
    soldForView = capacity - remaining;
    totalCapacity = capacity;
    comingSoon = false;
    lote = remaining > 0 ? { name: products[0].name, price: Math.min(...products.map((p) => p.price)), remaining } : null;
  }
  res.render('index', {
    eventInfo, lote, maxQty, error: null, soldOutLotes: productMode ? [] : getSoldOutLotes(lotes, soldCount),
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    comingSoon,
    soldCount: soldForView,
    totalCapacity,
    productMode,
    products: products.map((p) => ({ ...p, half: Math.round((p.price / 2) * 100) / 100 })),
    childRules: getChildRules(currentEvent),
    baseUrl: process.env.BASE_URL || '',
  });
});

const LEGAL_UPDATED_AT = '09/10/2026';

// Live ticket count for the home page (read only, never writes the DB).
app.get('/api/disponibilidade', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const db = store.load();
  const total = currentEvent.capacity || 0;
  const left = getProducts(currentEvent).length > 0 ? getAvailable(db) : Math.max(0, total - getSoldCount(db));
  res.json({ open: salesOpenNow(), total, left, sold: Math.max(0, total - left) });
});

// Lets the WhatsApp FAQ bot (n8n) always quote the real current event instead
// of a date baked into its prompt, and tell live from "no event on sale yet".
app.get('/api/evento-atual', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const db = store.load();
  const products = getProducts(currentEvent);
  const rules = products.length ? getChildRules(currentEvent) : null;
  const heldUntil = salesHeldBack(currentEvent) ? salesOpensAt(currentEvent) : null;
  res.json({
    salesOpen: salesOpenNow(),
    eventName: currentEvent.name,
    dateLabel: currentEvent.dateLabel,
    timeLabel: currentEvent.timeLabel || '',
    venue: currentEvent.venue,
    communityUrl: app.locals.communityUrl,
    // Used by the WhatsApp bot (Davi) to announce the party, tickets left and prices.
    capacity: currentEvent.capacity || null,
    ticketsLeft: products.length ? getAvailable(db) : null,
    products: products.map((p) => ({ name: p.name, price: p.price, includes: p.includes || [] })),
    childRules: rules ? { freeUntil: rules.freeUntil, halfUntil: rules.halfUntil } : null,
    salesOpensAtLabel: heldUntil ? opensLabelBR(heldUntil) : null,
  });
});

app.get('/politica-de-privacidade', (req, res) => {
  res.render('privacidade', { eventInfo, updatedAt: LEGAL_UPDATED_AT });
});

app.get('/termos-de-uso', (req, res) => {
  res.render('termos', { eventInfo, updatedAt: LEGAL_UPDATED_AT });
});

app.get('/politica-de-cancelamento', (req, res) => {
  res.render('cancelamento', { eventInfo, updatedAt: LEGAL_UPDATED_AT });
});

app.get('/checkout/dados', (req, res) => {
  if (!salesOpenNow()) return res.redirect('/');
  const db = store.load();

  if (getProducts(currentEvent).length > 0) {
    const remaining = getAvailable(db);
    const purchase = buildPurchase(currentEvent, req.query, { maxPersons: maxQty, remaining });
    if (purchase.error) return res.redirect('/');
    return res.render('checkout_dados', {
      eventInfo,
      quantity: purchase.persons,
      loteName: purchase.product.name,
      total: purchase.total,
      purchase: {
        produto: purchase.product.id,
        adultos: Number(req.query.adultos) || 0,
        criancas: Number(req.query.criancas) || 0,
        bebes: Number(req.query.bebes) || 0,
        items: purchase.items,
        includes: purchase.includes,
      },
      mpPublicKey: process.env.MP_PUBLIC_KEY,
    });
  }

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
  if (!salesOpenNow()) {
    return res.status(403).json({ error: app.locals.salesOpen ? 'As vendas ainda não começaram. Volte no horário de abertura.' : 'As vendas de ingressos estão encerradas.' });
  }
  try {
    const { buyerName, buyerEmail, buyerPhone, buyerCpf, quantity, formData } = req.body;

    if (!buyerName || !buyerEmail || !buyerPhone || !buyerCpf || !formData) {
      return res.status(400).json({ error: 'Preencha nome, e-mail, WhatsApp e CPF para continuar.' });
    }
    if (!isValidCpf(buyerCpf)) {
      return res.status(400).json({ error: 'CPF invalido. Confira e tente novamente.' });
    }

    const db = store.load();

    // Product purchase (Ingresso Simples / Passaporte + children): priced here, never by the client.
    if (getProducts(currentEvent).length > 0) {
      // Check and reserve the seats in one atomic step, before talking to Mercado Pago.
      const reservation = await store.withDb((d) => {
        const remaining = getAvailable(d);
        if (remaining <= 0) return { error: 'Os ingressos se esgotaram.' };
        const purchase = buildPurchase(currentEvent, req.body, { maxPersons: maxQty, remaining });
        if (purchase.error) return { error: purchase.error };
        const order = {
          id: crypto.randomUUID(),
          buyerName,
          buyerEmail,
          buyerPhone,
          buyerCpf: String(buyerCpf).replace(/D/g, ''),
          quantity: purchase.persons,
          eventId: currentEvent.id,
          productId: purchase.product.id,
          loteName: purchase.product.name,
          unitPrice: purchase.product.price,
          items: purchase.items,
          includes: purchase.includes,
          totalAmount: purchase.total,
          status: 'pending',
          mpPaymentId: null,
          paymentMethodId: formData.payment_method_id || null,
          pixQrCode: null,
          pixQrCodeBase64: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        d.orders[order.id] = order;
        return { order };
      });
      if (reservation.error) return res.status(400).json({ error: reservation.error });
      const productOrder = reservation.order;

      let productPayment;
      try {
        productPayment = await mp.createPayment(productOrder, formData);
      } catch (err) {
        await store.withDb((d) => { delete d.orders[productOrder.id]; }); // release the seats
        throw err;
      }

      if (productPayment.status === 'rejected') {
        await store.withDb((d) => { d.orders[productOrder.id] = { ...productOrder, status: 'rejected', mpPaymentId: String(productPayment.id) }; });
        return res.status(400).json({ error: describeRejection(productPayment.status_detail) });
      }
      const qr = productPayment.point_of_interaction?.transaction_data;
      await store.withDb((d) => {
        d.orders[productOrder.id] = {
          ...(d.orders[productOrder.id] || productOrder),
          mpPaymentId: String(productPayment.id),
          pixQrCode: qr ? qr.qr_code || null : null,
          pixQrCodeBase64: qr ? qr.qr_code_base64 || null : null,
          updatedAt: new Date().toISOString(),
        };
      });
      if (productPayment.status === 'approved') await approveOrder(productOrder.id, productPayment.id, eventInfo);
      return res.json({ redirectUrl: `/pedido/${productOrder.id}` });
    }

    const lotesNow = getLotes(db);
    if (lotesNow.length === 0) {
      return res.status(400).json({ error: 'A venda de ingressos ainda não foi aberta.' });
    }
    const lote = getCurrentLote(lotesNow, getSoldCount(db));
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
      eventId: currentEvent.id,
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
  res.render('order_status', { eventInfo: eventInfoFor(order), order, tickets, whatsappTicketLink: buildWhatsappTicketLink() });
});

app.get('/pedido/:id/participantes', (req, res) => {
  const db = store.load();
  const order = db.orders[req.params.id];
  if (!order || order.status !== 'paid') return res.status(404).send('Pedido nao encontrado.');

  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  res.render('participantes', { eventInfo: eventInfoFor(order), order, tickets, saved: req.query.saved === '1' });
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

// Self-service lookup: buyer types in the CPF, e-mail or WhatsApp used at
// checkout to find their paid order(s) and get to the participant-registration
// page, without needing the order id/link from the confirmation e-mail.
app.get('/foto', (req, res) => {
  res.render('foto', { eventInfo });
});

app.get('/meus-ingressos', (req, res) => {
  res.render('meus_ingressos', { eventInfo, error: null, matches: null, termo: '' });
});

app.post('/meus-ingressos', (req, res) => {
  const termo = String(req.body.termo || '').trim();
  if (!termo) {
    return res.render('meus_ingressos', { eventInfo, error: 'Digite seu CPF, e-mail ou WhatsApp.', matches: null, termo });
  }

  const digits = termo.replace(/\D/g, '');
  const isEmail = termo.includes('@');
  const phoneSuffix = (p) => String(p || '').replace(/\D/g, '').slice(-10);

  const db = store.load();
  const orders = Object.values(db.orders)
    .filter((o) => {
      // Cancelled orders stay searchable so the buyer can pull up the refund receipt.
      if (o.status !== 'paid' && o.status !== 'cancelled') return false;
      if (isEmail) return String(o.buyerEmail || '').trim().toLowerCase() === termo.toLowerCase();
      if (digits.length === 11) {
        return String(o.buyerCpf || '').replace(/\D/g, '') === digits || phoneSuffix(o.buyerPhone) === digits.slice(-10);
      }
      if (digits.length >= 10) return phoneSuffix(o.buyerPhone) === digits.slice(-10);
      return false;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (orders.length === 0) {
    return res.render('meus_ingressos', {
      eventInfo,
      error: 'Nao encontramos nenhuma compra aprovada com esses dados. Confira se digitou certo.',
      matches: null,
      termo,
    });
  }

  if (orders.length === 1) {
    return res.redirect(orders[0].status === 'cancelled' ? `/comprovante/${orders[0].id}` : `/pedido/${orders[0].id}/participantes`);
  }

  const matches = orders.map((o) => ({ ...o, createdAtLabel: formatDatetimeBrasiliaDisplay(o.createdAt) }));
  res.render('meus_ingressos', { eventInfo, error: null, matches, termo });
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
  res.render('ticket', { eventInfo: order ? eventInfoFor(order) : eventInfo, ticket, order });
});

app.get('/ingresso/:code/pdf', (req, res) => {
  const db = store.load();
  const ticket = db.tickets[req.params.code];
  if (!ticket || !ticket.pdfBase64) return res.status(404).send('Ingresso nao encontrado.');
  if (ticket.status === 'cancelled') return res.status(410).send('Ingresso cancelado.');

  const buffer = Buffer.from(ticket.pdfBase64, 'base64');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="ingresso-${ticket.code}.pdf"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------
// Busca de ingresso por CPF (usada pelo agente de atendimento no n8n)
// ---------------------------------------------------------------------

app.post('/api/ingressos/buscar', (req, res) => {
  const secret = process.env.INGRESSOS_LOOKUP_SECRET;
  if (!secret) return res.status(503).json({ error: 'not_configured' });
  if (req.get('x-api-key') !== secret) return res.status(401).json({ error: 'unauthorized' });

  const cpf = String(req.body.cpf || '').replace(/\D/g, '');
  if (!isValidCpf(cpf)) return res.status(400).json({ error: 'cpf_invalido' });

  const db = store.load();
  const orders = Object.values(db.orders).filter((o) => o.buyerCpf === cpf && o.status === 'paid');
  if (orders.length === 0) return res.json({ found: false });

  const tickets = [];
  for (const order of orders) {
    Object.values(db.tickets)
      .filter((t) => t.orderId === order.id && t.pdfBase64)
      .forEach((ticket) => {
        tickets.push({
          codigo: ticket.code,
          numeroSorteio: ticket.drawNumber ? String(ticket.drawNumber).padStart(6, '0') : '',
          nomeLote: order.loteName,
          pdfBase64: ticket.pdfBase64,
          fileName: `ingresso-${ticket.code}.pdf`,
        });
      });
  }

  res.json({ found: tickets.length > 0, nome: orders[0].buyerName, tickets });
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

    // Refund / chargeback done outside the panel (e.g. in the Mercado Pago
    // app): the money is already gone, so invalidate the tickets here too.
    if (payment.status === 'refunded' || payment.status === 'charged_back') {
      const now = new Date().toISOString();
      let cancelledNow = false;
      await store.withDb((d) => {
        const o = d.orders[orderId];
        // Already cancelled in the panel without a refund, then refunded by
        // hand afterwards: just record that the refund went through.
        if (o && o.status === 'cancelled' && !o.refund) {
          o.refund = { method: 'mercadopago-externo', id: null, amount: o.totalAmount, status: payment.status, at: now };
          return;
        }
        if (!o || o.status !== 'paid') return;
        cancelledNow = true;
        o.status = 'cancelled';
        o.cancelledAt = now;
        o.cancelReason = payment.status === 'charged_back' ? 'Chargeback' : 'Reembolsado no Mercado Pago';
        o.refund = o.refund || { method: 'mercadopago-externo', id: null, amount: o.totalAmount, status: payment.status, at: now };
        o.updatedAt = now;
        Object.values(d.tickets).forEach((t) => {
          if (t.orderId === orderId && t.status !== 'used') {
            t.status = 'cancelled';
            t.cancelledAt = now;
          }
        });
      });
      // A refund done by hand in the Mercado Pago app: tell the customer too
      // (fire-and-forget so the webhook answers fast). Chargebacks are the
      // bank's doing, so no automatic message for those.
      if (cancelledNow && payment.status === 'refunded') {
        sendReceiptNotification(orderId, { eventInfo, formatDatetime: formatDatetimeBrasiliaDisplay, channel: 'both' })
          .catch((err) => console.error(`Erro ao avisar cliente do reembolso do pedido ${orderId}:`, err.message));
      }
      return res.sendStatus(200);
    }

    if (payment.status !== 'approved') {
      return res.sendStatus(200);
    }

    if (orderId.startsWith('musica_')) {
      await aprovarPedidoMusica(orderId, dataId);
    } else {
      await approveOrder(orderId, dataId, eventInfo);
    }

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

  if (ticket.status === 'cancelled') {
    return res.json({
      result: 'invalido',
      message: 'Ingresso CANCELADO. Entrada nao liberada.',
      code: ticket.code,
    });
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
    if (t && t.status !== 'used' && t.status !== 'cancelled') {
      t.status = 'used';
      t.usedAt = usedAt;
    }
  });

  return res.json({
    result: 'valido',
    message: 'Ingresso valido. Entrada liberada!' +
      (ticket.kindLabel ? ` ${order ? order.loteName : ''} · ${ticket.kindLabel}.` : '') +
      (ticket.includes && ticket.includes.length ? ` Inclui: ${ticket.includes.join(', ')}.` : ''),
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
  const selectedEventId = EVENTS.some((e) => e.id === req.query.evento) ? req.query.evento : currentEvent.id;
  const events = eventsForSwitcher(db);
  const orders = Object.values(db.orders)
    .filter((o) => inEvent(o, selectedEventId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const stats = { totalRevenue: 0, ticketsSold: 0, paidOrders: 0 };
  const loteMap = {};

  orders.forEach((o) => {
    if (o.status !== 'paid' || o.isCourtesy) return;
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
    receiptSentAtLabel: o.receiptSentAt ? formatDatetimeBrasiliaDisplay(o.receiptSentAt) : '',
    whatsappResendLink: buildAdminWhatsappResendLink(o),
    whatsappReceiptLink: o.status === 'cancelled' ? buildAdminWhatsappReceiptLink(o, formatDatetimeBrasiliaDisplay) : null,
  }));

  res.render('admin_dashboard', {
    eventInfo,
    stats,
    loteBreakdown: Object.values(loteMap),
    events,
    selectedEventId,
    orders: ordersWithDate,
    broadcastConfigured: Boolean(process.env.N8N_BROADCAST_WEBHOOK_URL),
  });
});

// Pages outside /admin that send the user through the admin login and back.
const ADMIN_LOGIN_NEXT = ['/downloads', '/contabilidade'];

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
    return res.redirect(ADMIN_LOGIN_NEXT.includes(req.body.next) ? req.body.next : '/admin');
  }
  return res.status(401).render('admin_login', {
    eventInfo,
    error: 'Login ou senha incorretos.',
    next: ADMIN_LOGIN_NEXT.includes(req.body.next) ? req.body.next : null,
  });
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

// Cancels a paid order: invalidates its tickets (the QR stops validating) and,
// when asked, refunds the full payment through Mercado Pago first. Nothing is
// deleted — the order and tickets stay on record with status 'cancelled'.
app.post('/api/admin/pedidos/:id/cancelar', requireAdminAuth, async (req, res) => {
  const reembolsar = req.body.reembolsar === true || req.body.reembolsar === 'true';
  const jaReembolsado = req.body.jaReembolsado === true || req.body.jaReembolsado === 'true';
  const motivo = String(req.body.motivo || '').trim().slice(0, 200);
  // Customer is told about the cancellation (e-mail + WhatsApp) unless the admin opts out.
  const notificar = req.body.notificar !== false && req.body.notificar !== 'false';

  const db = store.load();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  if (order.status === 'cancelled') return res.status(400).json({ error: 'Este pedido ja foi cancelado.' });
  if (order.status !== 'paid') return res.status(400).json({ error: 'So e possivel cancelar pedidos pagos.' });

  const tickets = Object.values(db.tickets).filter((t) => t.orderId === order.id);
  if (tickets.some((t) => t.status === 'used')) {
    return res.status(400).json({ error: 'Este pedido ja tem ingresso utilizado na entrada. Nao e possivel cancelar.' });
  }

  let refund = null;
  if (reembolsar && !order.isCourtesy) {
    if (!/^\d+$/.test(String(order.mpPaymentId || ''))) {
      return res.status(400).json({ error: 'Pedido sem pagamento do Mercado Pago para reembolsar.' });
    }
    // The refund must always be the FULL amount the customer paid, so look
    // at the real payment first: never refund twice, and never start from a
    // payment that was already partially refunded.
    let payment;
    try {
      payment = await mp.getPayment(order.mpPaymentId);
    } catch (err) {
      console.error(`Erro ao consultar pagamento do pedido ${order.id}:`, err.message);
      return res.status(502).json({ error: 'Nao foi possivel consultar o pagamento no Mercado Pago agora. O pedido NAO foi cancelado. Tente novamente.' });
    }

    const paidAmount = Number(
      (payment.transaction_details && payment.transaction_details.total_paid_amount) || payment.transaction_amount || order.totalAmount
    );
    const alreadyRefunded = Number(payment.transaction_amount_refunded || 0);

    if (payment.status === 'refunded') {
      // Already refunded in full (e.g. by hand in the Mercado Pago app): just record it.
      refund = {
        method: 'mercadopago-externo',
        id: null,
        amount: alreadyRefunded || paidAmount,
        paidAmount,
        status: 'refunded',
        at: new Date().toISOString(),
      };
    } else if (payment.status !== 'approved') {
      return res.status(400).json({ error: `O pagamento esta com status "${payment.status}" no Mercado Pago e nao pode ser reembolsado.` });
    } else if (alreadyRefunded > 0) {
      return res.status(400).json({
        error: `Este pagamento ja teve reembolso parcial de R$ ${alreadyRefunded.toFixed(2).replace('.', ',')}. Complete o reembolso pelo app do Mercado Pago e use "ja reembolsei manualmente".`,
      });
    } else {
      try {
        const result = await mp.refundPayment(order.mpPaymentId);
        const refundedAmount = result && result.amount != null ? Number(result.amount) : paidAmount;
        refund = {
          method: 'mercadopago',
          id: result && result.id ? String(result.id) : null,
          amount: refundedAmount,
          paidAmount,
          status: result && result.status ? result.status : 'approved',
          at: new Date().toISOString(),
        };
      } catch (err) {
        const detail = err && (err.message || (err.cause && err.cause[0] && err.cause[0].description)) || 'erro desconhecido';
        console.error(`Erro ao reembolsar pedido ${order.id}:`, detail);
        return res.status(502).json({
          error: `O Mercado Pago recusou o reembolso (${detail}). O pedido NAO foi cancelado. Se faltar saldo na conta, adicione saldo e tente de novo, ou reembolse pelo app e use "ja reembolsei manualmente".`,
        });
      }
    }
  } else if (jaReembolsado && !order.isCourtesy) {
    refund = { method: 'manual', id: null, amount: order.totalAmount, paidAmount: order.totalAmount, status: 'approved', at: new Date().toISOString() };
  }

  const now = new Date().toISOString();
  await store.withDb((d) => {
    const o = d.orders[order.id];
    if (!o) return;
    o.status = 'cancelled';
    o.cancelledAt = now;
    o.cancelReason = motivo || null;
    o.refund = refund;
    o.updatedAt = now;
    Object.values(d.tickets).forEach((t) => {
      if (t.orderId === order.id && t.status !== 'used') {
        t.status = 'cancelled';
        t.cancelledAt = now;
      }
    });
  });

  let notified = false;
  let notifyError = null;
  if (notificar) {
    try {
      await sendReceiptNotification(order.id, {
        eventInfo,
        formatDatetime: formatDatetimeBrasiliaDisplay,
        channel: 'both',
      });
      notified = true;
    } catch (err) {
      // The cancellation (and refund) already happened — a failed notice must not undo it.
      notifyError = err.message;
      console.error(`Erro ao avisar cliente do cancelamento do pedido ${order.id}:`, err.message);
    }
  }

  return res.json({ ok: true, refunded: Boolean(refund), refund, notified, notifyError });
});

// Called by n8n when a customer messages the WhatsApp number asking for their
// ticket. Looks up the most recent paid order for that phone number and, if
// found, resends it (WhatsApp + e-mail) — this is a reply within a
// conversation the customer started, so it doesn't risk the number being
// flagged for cold-starting conversations the way the automatic post-purchase
// send would.
//
// Falls back to a CPF match when the phone doesn't match anything — happens
// when the buyer messages from a different number than the one used at
// checkout (personal vs. business WhatsApp, new chip, etc).
app.post('/api/n8n/ingresso-por-telefone', async (req, res) => {
  const secret = process.env.N8N_CALLBACK_SECRET;
  if (secret && req.headers['x-callback-secret'] !== secret) {
    return res.status(401).json({ found: false, error: 'unauthorized' });
  }

  const phone = String(req.body.telefone || '').replace(/\D/g, '');
  const cpf = String(req.body.cpf || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ found: false });

  const normalizePhoneSuffix = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const targetSuffix = normalizePhoneSuffix(phone);

  const db = store.load();
  let matchingOrders = Object.values(db.orders)
    .filter((o) => o.status === 'paid' && normalizePhoneSuffix(o.buyerPhone) === targetSuffix)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (matchingOrders.length === 0 && cpf.length === 11) {
    matchingOrders = Object.values(db.orders)
      .filter((o) => o.status === 'paid' && String(o.buyerCpf || '').replace(/\D/g, '') === cpf)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

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

// Called by the "WORKFLOW CREWOLADA" n8n workflow once the WhatsApp music-bot
// interview is done and approved by the buyer: creates the R$10 Pix charge
// and hands back the QR code for n8n to send. Payment confirmation arrives
// later through the shared Mercado Pago webhook below.
app.post('/api/n8n/musica/pedido', async (req, res) => {
  const secret = process.env.N8N_CALLBACK_SECRET;
  if (secret && req.headers['x-callback-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { remoteJid, nome, cpf, email, estilo, andamento, vocal, letra, referencia, ref } = req.body;
  if (!remoteJid || !cpf || !estilo || !letra) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }
  if (!isValidCpf(cpf)) {
    return res.status(400).json({ ok: false, error: 'invalid_cpf' });
  }

  // Only Christian lyrics: screened before the Pix is created (n8n tells the buyer what to fix).
  const veredito = await validarLetraCrista(String(letra));
  if (!veredito.aprovada) {
    return res.json({ ok: false, error: 'conteudo_nao_cristao', motivo: veredito.motivo });
  }

  try {
    // WhatsApp sale that came from an affiliate link: the bot sends the referral code it read.
    const afiliacao = ref ? require('./afiliados').atribuirPorRef(ref, { email, cpf }) : null;
    const resultado = await criarPedidoMusica({ remoteJid, nome, cpf, email, estilo, andamento, vocal, letra, referencia, afiliacao });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error('Erro ao criar pedido de musica:', err.message);
    return res.status(500).json({ ok: false, error: 'payment_failed' });
  }
});

// Called by n8n once Mureka finishes generating a song, so the
// /musica/pedido/:id status page (site-originated orders) can show/play it.
app.post('/api/n8n/musica/pronta', async (req, res) => {
  const secret = process.env.N8N_CALLBACK_SECRET;
  if (secret && req.headers['x-callback-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { pedidoId, audioUrl } = req.body;
  if (!pedidoId || !audioUrl) return res.status(400).json({ ok: false, error: 'missing_fields' });

  const pedido = await marcarMusicaPronta(pedidoId, audioUrl);
  if (!pedido) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
  // Saved copy + e-mail with the listen/download link (after answering n8n).
  posEntregaMusica(pedido).catch((err) => console.error('Erro na pos-entrega da musica:', err.message));
});

// The buyer asked for the song on WhatsApp ("Olá, gostaria de receber minha música por aqui.
// Código: XXXX"): n8n looks the order up by that code and, if the song is ready, sends the audio.
app.post('/api/n8n/musica/entrega', (req, res) => {
  const secret = process.env.N8N_CALLBACK_SECRET;
  if (secret && req.headers['x-callback-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const pedido = buscarPedidoPorCodigo(req.body.codigo);
  if (!pedido) return res.json({ ok: true, found: false, ready: false });
  const ready = pedido.status === 'entregue' && Boolean(pedido.audioUrl);
  return res.json({
    ok: true,
    found: true,
    ready,
    nome: pedido.nome || '',
    status: pedido.status,
    audioUrl: ready ? (process.env.BASE_URL || '').replace(/\/$/, '') + '/musica/pedido/' + pedido.id + '/audio' : null,
  });
});

registerCortesiaRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay });
registerComprovanteRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay });
registerContabilidadeRoutes(app, { isAdmin, requireAdminAuth, eventInfo });
registerRelatorioRoutes(app, { requireAdminAuth, eventInfo });
registerContatoRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay });
registerLinksRoutes(app, {
  requireAdminAuth, eventInfo, salesOpenNow: () => salesOpenNow(),
  availableNow: () => (getProducts(currentEvent).length > 0 ? getAvailable(store.load()) : null),
});
registerEventosRoutes(app, {
  requireAdminAuth, eventInfo, onChange: refreshEvents, parseDatetimeLocalAsBrasilia, formatDatetimeLocalBrasilia,
});
registerPesquisaRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay });
registerMusicaPersonalizadaRoutes(app, { eventInfo });

app.get('/admin/lotes', requireAdminAuth, (req, res) => {
  const db = store.load();
  const ev = EVENTS.find((e) => e.id === req.query.evento) || currentEvent;
  const lotes = getLotes(db, ev.id);
  const soldCount = getSoldCount(db, ev.id);
  res.render('admin_lotes', {
    eventInfo, lotesEvent: { ...ev, status: eventStatus(ev) }, lotes, soldCount, capacity: ev.capacity || null, saved: req.query.saved === '1',
  });
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

  const evId = EVENTS.some((e) => e.id === req.body.evento) ? req.body.evento : currentEvent.id;
  await store.withDb((db) => {
    if (evId === LEGACY_EVENT.id) {
      db.lotes = lotes;
    } else {
      db.eventLotes = db.eventLotes || {};
      db.eventLotes[evId] = lotes;
    }
  });

  res.redirect(`/admin/lotes?evento=${encodeURIComponent(evId)}&saved=1`);
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
    musicaAbandonoHoras: Number(process.env.MUSICA_ABANDONO_HORAS || 2),
    musicaRecompraDias: Number(process.env.MUSICA_RECOMPRA_DIAS || 7),
    saved: req.query.saved === '1',
  });
});

app.post('/api/admin/mensagens', requireAdminAuth, async (req, res) => {
  const { compra, dias5, dia1, diaEvento, hora1, musicaAbandono, musicaRecompra, eventStartAt } = req.body;
  await store.withDb((db) => {
    db.messageTemplates = { compra, dias5, dia1, diaEvento, hora1, musicaAbandono, musicaRecompra };
    if (eventStartAt) {
      const parsed = parseDatetimeLocalAsBrasilia(eventStartAt);
      if (parsed !== db.eventStartAt) db.remindersSent = {};
      db.eventStartAt = parsed;
    }
  });
  res.redirect('/admin/mensagens?saved=1');
});

app.post('/api/admin/campanhas', requireAdminAuth, async (req, res) => {
  const mensagem = String(req.body.mensagem || '').trim();
  const sendAtLocal = req.body.sendAt;
  if (!mensagem || !sendAtLocal) {
    return res.redirect('/admin/mensagens');
  }
  const audiencia = ['ingressos', 'musica', 'todos'].includes(req.body.audiencia) ? req.body.audiencia : 'ingressos';

  const campaign = {
    id: crypto.randomUUID(),
    mensagem,
    audiencia,
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

// ---- painel do "Crie Sua Propria Musica" (pedidos de musica personalizada via IA) ----
app.get('/admin/criesuamusica', requireAdminAuth, (req, res) => {
  const db = store.load();
  const pedidos = Object.values(db.musicaPedidos || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const porStatus = { aguardando_pagamento: 0, pago: 0, gerando: 0, entregue: 0 };
  let faturado = 0;
  let abandonados = 0;
  for (const p of pedidos) {
    porStatus[p.status] = (porStatus[p.status] || 0) + 1;
    if (p.status === 'pago' || p.status === 'gerando' || p.status === 'entregue') faturado += Number(p.valor) || 0;
    if (p.status === 'aguardando_pagamento' && p.lembreteAbandonoEnviado) abandonados += 1;
  }
  const total = pedidos.length;
  const pagos = (porStatus.pago || 0) + (porStatus.gerando || 0) + (porStatus.entregue || 0);
  const conversao = total > 0 ? Math.round((pagos / total) * 100) : 0;

  res.render('admin_criesuamusica', {
    eventInfo,
    pedidos: pedidos.map((p) => ({
      ...p,
      codigo: codigoCurto(p.id),
      createdAtLabel: formatDatetimeLocalBrasilia(p.createdAt).replace('T', ' '),
    })),
    total,
    porStatus,
    faturado,
    abandonados,
    conversao,
    preco: PRECO_MUSICA,
  });
});

// ---- musicas: sugestoes diarias para a playlist do evento ----
app.get('/downloads', (req, res) => {
  const token = req.cookies.admin_session;
  if (!token || !adminSessions.has(token)) {
    return res.render('admin_login', { eventInfo, error: null, next: '/downloads' });
  }
  const state = musicas.load();
  const days = Object.keys(state.days).sort().reverse();
  const view = ['playlist', 'comprar'].includes(req.query.ver) ? req.query.ver : 'gratis';
  const date = days.includes(req.query.data) ? req.query.data : days[0] || null;

  let tracks = [];
  if (view === 'playlist') {
    const byId = {};
    for (const d of days) for (const t of [...(state.days[d].free || []), ...state.days[d].tracks]) byId[t.id] = t;
    tracks = Object.keys(state.marks).filter((id) => state.marks[id] === 'playlist' && byId[id]).map((id) => byId[id]);
  } else if (date) {
    tracks = view === 'gratis' ? state.days[date].free || [] : state.days[date].tracks;
  }

  const artists = Object.values(state.artists).sort((a, b) => a.name.localeCompare(b.name));
  res.render('admin_musicas', {
    eventInfo,
    view,
    date,
    days,
    tracks,
    marks: state.marks,
    pending: artists.filter((a) => a.status === 'pendente'),
    approved: artists.filter((a) => a.status === 'aprovado'),
    estilos: musicas.ESTILOS,
    today: musicas.todayBrasilia(),
    msg: req.query.msg || null,
  });
});

app.post('/api/downloads/gerar', requireAdminAuth, async (req, res) => {
  try {
    await musicas.generateToday({ force: req.body.force === '1' });
    res.redirect('/downloads?msg=gerado');
  } catch (err) {
    console.error('[musicas] geracao manual falhou:', err.message);
    res.redirect('/downloads?msg=erro');
  }
});

app.post('/api/downloads/artista/:id', requireAdminAuth, async (req, res) => {
  const { status, estilo } = req.body;
  if (['aprovado', 'rejeitado', 'pendente'].includes(status)) await musicas.setArtistStatus(req.params.id, status);
  if (estilo) await musicas.setArtistEstilo(req.params.id, estilo);
  if (req.is('json')) return res.json({ ok: true });
  res.redirect(req.get('referer') || '/downloads');
});

app.post('/api/downloads/artista', requireAdminAuth, async (req, res) => {
  const name = String(req.body.nome || '').trim();
  const artist = name ? await musicas.addArtistByName(name, req.body.estilo).catch(() => null) : null;
  res.redirect(`/downloads?msg=${artist ? 'artista-ok' : 'artista-nao-encontrado'}`);
});

app.post('/api/downloads/faixa/:id', requireAdminAuth, async (req, res) => {
  if (!/^(bc-)?\d+$/.test(req.params.id)) return res.status(400).json({ ok: false });
  const mark = ['playlist', 'descartada'].includes(req.body.mark) ? req.body.mark : null;
  await musicas.setTrackMark(req.params.id, mark);
  res.json({ ok: true, mark });
});

app.get('/api/downloads/preview/:id', requireAdminAuth, async (req, res) => {
  try {
    const url = await musicas.previewUrl(req.params.id);
    if (!url) return res.status(404).send('Sem previa');
    res.redirect(url);
  } catch {
    res.status(502).send('Previa indisponivel');
  }
});

// ---------------------------------------------------------------------
// Free, limited registration pages (one per event with a slug), e.g. /SP.
// Registered last so no real route can ever be shadowed by a slug.
// ---------------------------------------------------------------------

const freeHits = new Map();
function freeRateLimited(ip) {
  const now = Date.now();
  const list = (freeHits.get(ip) || []).filter((x) => now - x < 3600000);
  list.push(now);
  freeHits.set(ip, list);
  return list.length > 20;
}

// Hidden (not yet published) events only exist for the logged-in admin, who can preview them.
function findFreeEvent(slug, req) {
  const s = String(slug || '').toLowerCase();
  const ev = EVENTS.find((e) => e.free && e.slug && e.slug.toLowerCase() === s) || null;
  if (ev && ev.hidden && !(req && isAdmin(req))) return null;
  return ev;
}

function freePageData(ev, db) {
  const capacity = ev.capacity || 0;
  const sold = getSoldCount(db, ev.id);
  const startMs = ev.startAt ? Date.parse(ev.startAt) : NaN;
  const weekday = Number.isNaN(startMs)
    ? ''
    : new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date(startMs));
  return {
    ev, capacity, sold, left: Math.max(0, capacity - sold), weekday,
    closed: !Number.isNaN(startMs) && Date.now() > startMs + 5 * 3600000,
    baseUrl: process.env.BASE_URL || '',
  };
}

app.get('/:slug', (req, res, next) => {
  const ev = findFreeEvent(req.params.slug, req);
  if (!ev) return next();
  res.render('evento_gratuito', {
    eventInfo: { ...eventInfo, ...ev }, ...freePageData(ev, store.load()), error: null, values: {},
  });
});

app.post('/:slug/inscricao', async (req, res, next) => {
  const ev = findFreeEvent(req.params.slug, req);
  if (!ev) return next();

  const evInfo = { ...eventInfo, ...ev };
  const renderError = (status, error) => res.status(status).render('evento_gratuito', {
    eventInfo: evInfo, ...freePageData(ev, store.load()), error, values: req.body,
  });

  if (req.body.website) return res.redirect(`/${ev.slug}`); // honeypot
  const clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  if (freeRateLimited(clientIp)) return renderError(429, 'Muitas tentativas em pouco tempo. Tente de novo mais tarde.');

  const buyerName = String(req.body.nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const buyerEmail = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  let phone = String(req.body.whatsapp || '').replace(/\D/g, '').replace(/^0+/, '');
  if (phone.length > 11 && phone.startsWith('55')) phone = phone.slice(2);
  const cpf = String(req.body.cpf || '').replace(/\D/g, '');
  const maxPer = ev.maxPerCpf || 4;
  const qty = Math.min(Math.max(parseInt(req.body.quantidade, 10) || 1, 1), maxPer);

  if (buyerName.length < 2) return renderError(400, 'Informe seu nome completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) return renderError(400, 'Informe um e-mail válido: é para lá que enviamos o ingresso.');
  if (!/^[1-9][1-9]\d{8,9}$/.test(phone)) return renderError(400, 'Informe um WhatsApp válido, com DDD.');
  if (!isValidCpf(cpf)) return renderError(400, 'CPF inválido. Confira e tente novamente.');
  if (req.body.consent !== 'on') return renderError(400, 'Para se inscrever, é preciso concordar com o uso dos dados.');

  const page = freePageData(ev, store.load());
  if (page.closed) return renderError(400, 'As inscrições deste evento foram encerradas.');

  const order = {
    id: crypto.randomUUID(),
    buyerName,
    buyerEmail,
    buyerPhone: phone,
    buyerCpf: cpf,
    quantity: qty,
    eventId: ev.id,
    productId: 'gratuito',
    loteName: 'Ingresso Gratuito',
    unitPrice: 0,
    totalAmount: 0,
    isFree: true,
    status: 'pending',
    mpPaymentId: null,
    paymentMethodId: 'gratuito',
    pixQrCode: null,
    pixQrCodeBase64: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Capacity and the per-CPF limit are checked and the order saved in one atomic step.
  const outcome = await store.withDb((d) => {
    const mine = Object.values(d.orders).filter((o) => inEvent(o, ev.id) && o.buyerCpf === cpf && (o.status === 'paid' || o.status === 'pending'));
    // Same person tapping twice: send them to the order they already have.
    const recent = mine.find((o) => o.buyerEmail === buyerEmail && Date.now() - Date.parse(o.createdAt) < 120000);
    if (recent) return { existing: recent.id };
    const already = mine.reduce((s, o) => s + o.quantity, 0);
    if (already + qty > maxPer) return { error: `Este CPF já tem ${already} ingresso(s). O limite é ${maxPer} por pessoa.` };
    if (getSoldCount(d, ev.id) + qty > (ev.capacity || 0)) return { error: 'Os ingressos acabaram. Entre na comunidade para saber dos próximos eventos.' };
    d.orders[order.id] = order;
    return { created: true };
  });

  if (outcome.existing) return res.redirect(`/pedido/${outcome.existing}`);
  if (outcome.error) return renderError(400, outcome.error);

  await approveOrder(order.id, `gratuito-${order.id}`, evInfo);
  return res.redirect(`/pedido/${order.id}`);
});

app.listen(PORT, () => {
  console.log(`Crewolada rodando em http://localhost:${PORT}`);
  startReminderScheduler();
  startMusicaFollowUpScheduler();
  musicas.startMusicScheduler();
});
