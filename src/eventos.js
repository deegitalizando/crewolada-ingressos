const store = require('./store');
const { opcoesHome } = require('./paginaInicial');
const { getLotes } = require('./lotes');
const { getProducts, getChildRules } = require('./produtos');
const {
  EVENTS, currentEvent, LEGACY_EVENT, NEXT_EVENT, SP_EVENT, PRE_REVEILLON_EVENT, syncEvents, orderEventId, eventStatus, salesHeldBack,
} = require('./event');

const SEED_IDS = new Set([LEGACY_EVENT.id, NEXT_EVENT.id, PRE_REVEILLON_EVENT.id, SP_EVENT.id]);

const slug = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'evento';

// dd/mm/yyyy in Brasilia time (fixed -3h, no DST since 2019).
function dateLabelBR(iso) {
  const d = new Date(new Date(iso).getTime() - 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

const eventById = (id) => EVENTS.find((e) => e.id === id) || LEGACY_EVENT;

function eventStats(db) {
  const stats = {};
  const get = (id) => (stats[id] = stats[id] || { orders: 0, tickets: 0, seats: 0, babies: 0, revenue: 0, attended: 0, courtesy: 0, cancelled: 0 });
  const orders = db.orders || {};
  Object.values(orders).forEach((o) => {
    const s = get(orderEventId(o));
    if (o.status === 'paid' && !o.isCourtesy) {
      s.orders += 1;
      s.tickets += o.quantity;
      // Free babies are sold but never take one of the limited seats.
      const babies = Array.isArray(o.items) ? o.items.filter((i) => i.kind === 'bebe').reduce((n, i) => n + i.qty, 0) : 0;
      const seatBabies = getChildRules(eventById(orderEventId(o))).freeCountsInCapacity ? 0 : babies;
      s.babies += seatBabies;
      s.seats += o.quantity - seatBabies;
      s.revenue += o.totalAmount;
    } else if (o.status === 'paid' && o.isCourtesy) {
      s.courtesy += o.quantity;
    } else if (o.status === 'cancelled' && !o.isCourtesy) {
      s.cancelled += 1;
    }
  });
  Object.values(db.tickets || {}).forEach((t) => {
    if (t.status !== 'used') return;
    const o = orders[t.orderId];
    if (o) get(orderEventId(o)).attended += 1;
  });
  return stats;
}

function registerEventosRoutes(app, { requireAdminAuth, eventInfo, onChange, parseDatetimeLocalAsBrasilia, formatDatetimeLocalBrasilia, getSoldCount }) {
  function readFields(body) {
    const name = String(body.name || '').trim().slice(0, 60);
    const venue = String(body.venue || '').trim().slice(0, 100);
    const timeLabel = String(body.timeLabel || '').trim().slice(0, 40);
    // Capacity is only sent for free events; paid ones manage it in the Ingressos tab.
    const hasCapacity = Object.prototype.hasOwnProperty.call(body, 'capacity');
    const capacity = Math.max(0, parseInt(body.capacity, 10) || 0) || null;
    const startAt = body.startAt ? parseDatetimeLocalAsBrasilia(body.startAt) : null;
    const salesOpenAt = body.salesOpenAt ? parseDatetimeLocalAsBrasilia(body.salesOpenAt) : null;
    const saleMode = body.saleMode === 'tipos' ? 'tipos' : 'lotes';
    return { name, venue, timeLabel, capacity, hasCapacity, startAt, salesOpenAt, saleMode };
  }

  app.get('/admin/eventos', requireAdminAuth, (req, res) => {
    const db = store.load();
    const stats = eventStats(db);
    const now = Date.now();
    const cards = EVENTS.map((e) => {
      const s = stats[e.id] || { orders: 0, tickets: 0, seats: 0, babies: 0, revenue: 0, attended: 0, courtesy: 0, cancelled: 0 };
      const lotesCap = getLotes(db, e.id).reduce((sum, l) => sum + l.quantity, 0);
      return {
        ...e,
        status: eventStatus(e, now),
        stats: s,
        lotesCapacity: lotesCap,
        startAtLocal: e.startAt ? formatDatetimeLocalBrasilia(e.startAt) : '',
        salesOpenAtLocal: e.salesOpenAt ? formatDatetimeLocalBrasilia(e.salesOpenAt) : '',
        salesHeld: e.id === currentEvent.id && salesHeldBack(e),
        isSeed: SEED_IDS.has(e.id),
        hasProducts: getProducts(e).length > 0,
        free: Boolean(e.free),
        slug: e.slug || '',
        hidden: Boolean(e.hidden),
        hasOrders: s.orders + s.courtesy + s.cancelled > 0,
      };
    });
    res.render('admin_eventos', {
      eventInfo,
      atual: cards.filter((c) => c.status === 'atual'),
      futuros: cards.filter((c) => c.status === 'futuro'),
      anteriores: cards.filter((c) => c.status === 'anterior').reverse(),
      cancelados: cards.filter((c) => c.status === 'cancelado'),
      home: opcoesHome(db),
      msg: req.query.msg || null,
    });
  });

  // ---- Ingressos tab: how an event sells (lotes OR ticket types) and its prices.
  // Lotes: 1º lote, 2º lote... the price moves to the next lote when one sells out.
  // Tipos: products (Ingresso Simples, Passaporte...) with half price for children.
  const paidEvents = () => EVENTS.filter((e) => !e.free);
  const saleModeOf = (ev) => (getProducts(ev).length > 0 ? 'tipos' : ev.saleMode === 'tipos' ? 'tipos' : 'lotes');

  app.get('/admin/ingressos', requireAdminAuth, (req, res) => {
    const db = store.load();
    const list = paidEvents();
    const ev = list.find((e) => e.id === req.query.evento) || (currentEvent.free ? list[list.length - 1] : currentEvent) || currentEvent;
    const lotes = getLotes(db, ev.id);
    const soldCount = getSoldCount(db, ev.id);
    let floor = 0;
    const lotesView = lotes.map((l) => {
      const ceiling = floor + l.quantity;
      const vendidos = Math.max(0, Math.min(l.quantity, soldCount - floor));
      const status = soldCount >= ceiling ? 'esgotado' : soldCount >= floor ? 'atual' : 'proximo';
      floor = ceiling;
      return { ...l, vendidos, status };
    });
    res.render('admin_ingressos', {
      eventInfo,
      ev: { ...ev, status: eventStatus(ev) },
      events: list.map((e) => ({ id: e.id, name: e.name, dateLabel: e.dateLabel, status: eventStatus(e) }))
        .sort((a, b) => ['atual', 'futuro', 'anterior', 'cancelado'].indexOf(a.status) - ['atual', 'futuro', 'anterior', 'cancelado'].indexOf(b.status)),
      mode: saleModeOf(ev),
      lotes: lotesView,
      soldCount,
      products: getProducts(ev),
      rules: getChildRules(ev),
      saved: req.query.saved === '1',
      novo: req.query.novo === '1',
      erro: req.query.erro || null,
    });
  });

  app.post('/admin/ingressos', requireAdminAuth, async (req, res) => {
    const ev = paidEvents().find((e) => e.id === req.body.evento);
    if (!ev) return res.redirect('/admin/ingressos');
    const back = (q) => res.redirect(`/admin/ingressos?evento=${encodeURIComponent(ev.id)}&${q}`);
    const soldCount = getSoldCount(store.load(), ev.id);
    const money = (v) => Math.round((parseFloat(String(v || '').replace(',', '.')) || 0) * 100) / 100;

    if (req.body.modo === 'lotes') {
      const lotes = Object.values(req.body.lotes || {})
        .map((l) => ({ name: String(l.name || '').trim().slice(0, 40), quantity: Math.max(0, parseInt(l.quantity, 10) || 0), price: money(l.price) }))
        .filter((l) => l.name && l.quantity > 0);
      if (!lotes.length) return back(`erro=${encodeURIComponent('Cadastre pelo menos um lote com nome e quantidade.')}`);
      if (lotes.some((l) => l.price <= 0)) return back(`erro=${encodeURIComponent('Todo lote precisa de um preço maior que zero.')}`);
      const total = lotes.reduce((n, l) => n + l.quantity, 0);
      if (total < soldCount) return back(`erro=${encodeURIComponent(`A soma dos lotes (${total}) não pode ser menor que os ${soldCount} ingressos já vendidos.`)}`);
      await store.withDb((db) => {
        if (ev.id === LEGACY_EVENT.id) db.lotes = lotes;
        else { db.eventLotes = db.eventLotes || {}; db.eventLotes[ev.id] = lotes; }
        db.events = db.events || {};
        db.events[ev.id] = { ...(db.events[ev.id] || {}), id: ev.id, products: [], saleMode: 'lotes', capacity: total };
      });
      onChange();
      return back('saved=1');
    }

    // modo === 'tipos'
    const existing = getProducts(ev);
    const taken = new Set();
    const products = Object.values(req.body.produtos || {})
      .map((p) => {
        const name = String(p.name || '').trim().slice(0, 60);
        const price = money(p.price);
        const includes = String(p.includes || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);
        const known = existing.find((x) => x.name.toLowerCase() === name.toLowerCase()) || existing.find((x) => x.id === p.id);
        let id = known ? known.id : slug(name);
        for (let i = 2; taken.has(id); i += 1) id = `${id}-${i}`;
        taken.add(id);
        return { id, name, price, includes };
      })
      .filter((p) => p.name);
    if (!products.length) return back(`erro=${encodeURIComponent('Cadastre pelo menos um tipo de ingresso.')}`);
    if (products.some((p) => p.price <= 0)) return back(`erro=${encodeURIComponent('Todo tipo de ingresso precisa de um preço maior que zero.')}`);
    const capacity = Math.max(0, parseInt(req.body.capacity, 10) || 0);
    if (!capacity) return back(`erro=${encodeURIComponent('Informe o total de ingressos à venda.')}`);
    if (capacity < soldCount) return back(`erro=${encodeURIComponent(`O total (${capacity}) não pode ser menor que os ${soldCount} ingressos já vendidos.`)}`);
    const freeUntil = Math.max(0, parseInt(req.body.freeUntil, 10) || 0);
    const halfUntil = Math.max(freeUntil, parseInt(req.body.halfUntil, 10) || 0);

    await store.withDb((db) => {
      db.events = db.events || {};
      db.events[ev.id] = {
        ...(db.events[ev.id] || {}),
        id: ev.id,
        saleMode: 'tipos',
        products,
        childRules: { freeUntil, halfUntil, freeCountsInCapacity: req.body.freeCounts === 'on' },
        capacity,
      };
    });
    onChange();
    back('saved=1');
  });

  app.post('/admin/eventos', requireAdminAuth, async (req, res) => {
    const f = readFields(req.body);
    if (!f.name || !f.startAt) return res.redirect('/admin/eventos?msg=dados');
    let created = null;
    await store.withDb((db) => {
      db.events = db.events || {};
      const base = `${slug(f.name)}-${f.startAt.slice(0, 10)}`;
      let id = base;
      for (let i = 2; db.events[id] || EVENTS.some((e) => e.id === id); i += 1) id = `${base}-${i}`;
      created = id;
      db.events[id] = {
        id, name: f.name, brand: 'Crewolada', dateLabel: dateLabelBR(f.startAt), timeLabel: f.timeLabel,
        venue: f.venue, startAt: f.startAt, salesOpenAt: f.salesOpenAt, saleMode: f.saleMode,
        products: [], capacity: null, createdAt: new Date().toISOString(),
      };
    });
    onChange();
    // Next step: program the tickets of the new event.
    res.redirect(`/admin/ingressos?evento=${encodeURIComponent(created)}&novo=1`);
  });

  app.post('/admin/eventos/:id/editar', requireAdminAuth, async (req, res) => {
    const f = readFields(req.body);
    if (!EVENTS.some((e) => e.id === req.params.id) || !f.name || !f.startAt) return res.redirect('/admin/eventos?msg=dados');
    await store.withDb((db) => {
      db.events = db.events || {};
      db.events[req.params.id] = {
        ...(db.events[req.params.id] || {}),
        id: req.params.id, name: f.name, dateLabel: dateLabelBR(f.startAt), timeLabel: f.timeLabel,
        venue: f.venue, startAt: f.startAt, salesOpenAt: f.salesOpenAt,
        ...(f.hasCapacity ? { capacity: f.capacity } : {}),
      };
    });
    onChange();
    res.redirect('/admin/eventos?msg=salvo');
  });

  // Releases the ticket sale right now (clears the "Em breve" hold).
  app.post('/admin/eventos/:id/liberar', requireAdminAuth, async (req, res) => {
    if (!EVENTS.some((e) => e.id === req.params.id)) return res.redirect('/admin/eventos?msg=dados');
    await store.withDb((db) => {
      db.events = db.events || {};
      db.events[req.params.id] = { ...(db.events[req.params.id] || {}), id: req.params.id, salesOpenAt: null };
    });
    onChange();
    res.redirect('/admin/eventos?msg=liberado');
  });

  // Free-registration pages: publish (visible to everyone) or hide again.
  ['publicar', 'ocultar'].forEach((action) => {
    app.post(`/admin/eventos/:id/${action}`, requireAdminAuth, async (req, res) => {
      const ev = EVENTS.find((e) => e.id === req.params.id);
      if (!ev || !ev.slug) return res.redirect('/admin/eventos?msg=dados');
      await store.withDb((db) => {
        db.events = db.events || {};
        db.events[ev.id] = { ...(db.events[ev.id] || {}), id: ev.id, hidden: action === 'ocultar' };
      });
      onChange();
      res.redirect(`/admin/eventos?msg=${action === 'publicar' ? 'publicado' : 'oculto'}`);
    });
  });

  app.post('/admin/eventos/:id/atual', requireAdminAuth, async (req, res) => {
    if (!EVENTS.some((e) => e.id === req.params.id)) return res.redirect('/admin/eventos?msg=dados');
    await store.withDb((db) => { db.currentEventId = req.params.id; });
    onChange();
    res.redirect('/admin/eventos?msg=atual');
  });

  app.post('/admin/eventos/:id/excluir', requireAdminAuth, async (req, res) => {
    const id = req.params.id;
    const db = store.load();
    const hasOrders = Object.values(db.orders || {}).some((o) => orderEventId(o) === id);
    if (!EVENTS.some((e) => e.id === id)) return res.redirect('/admin/eventos?msg=dados');
    if (id === currentEvent.id) return res.redirect('/admin/eventos?msg=nao-excluir-atual');
    if (hasOrders) return res.redirect('/admin/eventos?msg=nao-excluir-pedidos');
    await store.withDb((d) => {
      d.events = d.events || {};
      // Built-in events live in the code: they are only flagged as deleted.
      if (SEED_IDS.has(id)) d.events[id] = { id, deleted: true, deletedAt: new Date().toISOString() };
      else delete d.events[id];
      if (d.eventLotes) delete d.eventLotes[id];
      if (d.homePage === `gratuito:${id}`) d.homePage = 'evento';
    });
    onChange();
    res.redirect('/admin/eventos?msg=excluido');
  });
}

module.exports = { registerEventosRoutes };
