const store = require('./store');
const { getLotes } = require('./lotes');
const { getProducts, getChildRules } = require('./produtos');
const {
  EVENTS, currentEvent, LEGACY_EVENT, NEXT_EVENT, syncEvents, orderEventId, eventStatus,
} = require('./event');

const SEED_IDS = new Set([LEGACY_EVENT.id, NEXT_EVENT.id]);

const slug = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'evento';

// dd/mm/yyyy in Brasilia time (fixed -3h, no DST since 2019).
function dateLabelBR(iso) {
  const d = new Date(new Date(iso).getTime() - 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function eventStats(db) {
  const stats = {};
  const get = (id) => (stats[id] = stats[id] || { orders: 0, tickets: 0, revenue: 0, attended: 0, courtesy: 0, cancelled: 0 });
  const orders = db.orders || {};
  Object.values(orders).forEach((o) => {
    const s = get(orderEventId(o));
    if (o.status === 'paid' && !o.isCourtesy) {
      s.orders += 1;
      s.tickets += o.quantity;
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

function registerEventosRoutes(app, { requireAdminAuth, eventInfo, onChange, parseDatetimeLocalAsBrasilia, formatDatetimeLocalBrasilia }) {
  function readFields(body) {
    const name = String(body.name || '').trim().slice(0, 60);
    const venue = String(body.venue || '').trim().slice(0, 100);
    const timeLabel = String(body.timeLabel || '').trim().slice(0, 40);
    const capacity = Math.max(0, parseInt(body.capacity, 10) || 0) || null;
    const startAt = body.startAt ? parseDatetimeLocalAsBrasilia(body.startAt) : null;
    return { name, venue, timeLabel, capacity, startAt };
  }

  app.get('/admin/eventos', requireAdminAuth, (req, res) => {
    const db = store.load();
    const stats = eventStats(db);
    const now = Date.now();
    const cards = EVENTS.map((e) => {
      const s = stats[e.id] || { orders: 0, tickets: 0, revenue: 0, attended: 0, courtesy: 0, cancelled: 0 };
      const lotesCap = getLotes(db, e.id).reduce((sum, l) => sum + l.quantity, 0);
      return {
        ...e,
        status: eventStatus(e, now),
        stats: s,
        lotesCapacity: lotesCap,
        startAtLocal: e.startAt ? formatDatetimeLocalBrasilia(e.startAt) : '',
        isSeed: SEED_IDS.has(e.id),
        hasProducts: getProducts(e).length > 0,
        hasOrders: s.orders + s.courtesy + s.cancelled > 0,
      };
    });
    res.render('admin_eventos', {
      eventInfo,
      atual: cards.filter((c) => c.status === 'atual'),
      futuros: cards.filter((c) => c.status === 'futuro'),
      anteriores: cards.filter((c) => c.status === 'anterior').reverse(),
      msg: req.query.msg || null,
    });
  });

  // ---- ticket types of an event (Ingresso Simples, Passaporte...) + children's rules
  app.get('/admin/ingressos', requireAdminAuth, (req, res) => {
    const ev = EVENTS.find((e) => e.id === req.query.evento) || currentEvent;
    const products = getProducts(ev);
    res.render('admin_ingressos', {
      eventInfo,
      ev: { ...ev, status: eventStatus(ev) },
      products: products.concat(Array(Math.max(0, 4 - products.length)).fill(null)),
      rules: getChildRules(ev),
      saved: req.query.saved === '1',
    });
  });

  app.post('/admin/ingressos', requireAdminAuth, async (req, res) => {
    const ev = EVENTS.find((e) => e.id === req.body.evento);
    if (!ev) return res.redirect('/admin/ingressos');
    const existing = getProducts(ev);
    const taken = new Set();
    const products = Object.values(req.body.produtos || {})
      .map((p) => {
        const name = String(p.name || '').trim().slice(0, 60);
        const price = Math.round((parseFloat(String(p.price || '').replace(',', '.')) || 0) * 100) / 100;
        const includes = String(p.includes || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
        const known = existing.find((x) => x.name.toLowerCase() === name.toLowerCase());
        let id = known ? known.id : slug(name);
        for (let i = 2; taken.has(id); i += 1) id = `${id}-${i}`;
        taken.add(id);
        return { id, name, price, includes };
      })
      .filter((p) => p.name && p.price > 0);

    const freeUntil = Math.max(0, parseInt(req.body.freeUntil, 10) || 0);
    const halfUntil = Math.max(freeUntil, parseInt(req.body.halfUntil, 10) || 0);
    const capacity = Math.max(0, parseInt(req.body.capacity, 10) || 0) || null;

    await store.withDb((db) => {
      db.events = db.events || {};
      db.events[ev.id] = {
        ...(db.events[ev.id] || {}),
        id: ev.id,
        products,
        childRules: { freeUntil, halfUntil, freeCountsInCapacity: req.body.freeCounts === 'on' },
        capacity,
      };
    });
    onChange();
    res.redirect(`/admin/ingressos?evento=${encodeURIComponent(ev.id)}&saved=1`);
  });

  app.post('/admin/eventos', requireAdminAuth, async (req, res) => {
    const f = readFields(req.body);
    if (!f.name || !f.startAt) return res.redirect('/admin/eventos?msg=dados');
    await store.withDb((db) => {
      db.events = db.events || {};
      const base = `${slug(f.name)}-${f.startAt.slice(0, 10)}`;
      let id = base;
      for (let i = 2; db.events[id] || EVENTS.some((e) => e.id === id); i += 1) id = `${base}-${i}`;
      db.events[id] = {
        id, name: f.name, brand: 'Crewolada', dateLabel: dateLabelBR(f.startAt), timeLabel: f.timeLabel,
        venue: f.venue, startAt: f.startAt, capacity: f.capacity, createdAt: new Date().toISOString(),
      };
    });
    onChange();
    res.redirect('/admin/eventos?msg=criado');
  });

  app.post('/admin/eventos/:id/editar', requireAdminAuth, async (req, res) => {
    const f = readFields(req.body);
    if (!EVENTS.some((e) => e.id === req.params.id) || !f.name || !f.startAt) return res.redirect('/admin/eventos?msg=dados');
    await store.withDb((db) => {
      db.events = db.events || {};
      db.events[req.params.id] = {
        ...(db.events[req.params.id] || {}),
        id: req.params.id, name: f.name, dateLabel: dateLabelBR(f.startAt), timeLabel: f.timeLabel,
        venue: f.venue, startAt: f.startAt, capacity: f.capacity,
      };
    });
    onChange();
    res.redirect('/admin/eventos?msg=salvo');
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
    if (SEED_IDS.has(id) || id === currentEvent.id || hasOrders || !(db.events || {})[id]) {
      return res.redirect('/admin/eventos?msg=nao-pode-excluir');
    }
    await store.withDb((d) => {
      delete d.events[id];
      if (d.eventLotes) delete d.eventLotes[id];
    });
    onChange();
    res.redirect('/admin/eventos?msg=excluido');
  });
}

module.exports = { registerEventosRoutes };
