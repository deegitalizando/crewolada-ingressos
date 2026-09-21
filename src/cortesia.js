const crypto = require('crypto');
const store = require('./store');
const { approveOrder } = require('./fulfillment');
const { isValidCpf } = require('./cpf');

const COURTESY_LOTE_NAME = 'Cortesia';
const MAX_PEOPLE_PER_LINK = 50;

function cortesiaBaseUrl() {
  return (process.env.CORTESIA_BASE_URL || 'https://cortesia.crewolada.com').replace(/\/$/, '');
}

function linkUrl(token) {
  return `${cortesiaBaseUrl()}/c/${token}`;
}

function validatePerson(p) {
  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim();
  const phone = String(p.phone || '').replace(/\D/g, '');
  const cpf = String(p.cpf || '').replace(/\D/g, '');

  if (name.length < 3) return { error: 'Informe o nome completo.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'E-mail invalido.' };
  if (phone.length < 10) return { error: 'WhatsApp invalido (inclua o DDD).' };
  if (cpf && !isValidCpf(cpf)) return { error: 'CPF invalido.' };

  return { person: { name, email, phone: String(p.phone).trim(), cpf } };
}

function registerCortesiaRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay }) {
  // Cortesia pages never fire the sales pixel — they're not part of the
  // public funnel and shouldn't pollute ad reporting.
  const pageLocals = { eventInfo, metaPixelId: '' };

  // ---- guest-facing ----

  app.get('/c/:token', (req, res) => {
    const db = store.load();
    const link = (db.courtesyLinks || {})[req.params.token];
    if (!link) return res.status(404).render('cortesia_form', { ...pageLocals, state: 'invalid' });
    if (link.usedAt) return res.render('cortesia_form', { ...pageLocals, state: 'used', link });
    res.render('cortesia_form', { ...pageLocals, state: 'form', link, people: [], error: null });
  });

  app.post('/c/:token', async (req, res) => {
    const token = req.params.token;
    const db = store.load();
    const link = (db.courtesyLinks || {})[token];
    if (!link) return res.status(404).render('cortesia_form', { ...pageLocals, state: 'invalid' });
    if (link.usedAt) return res.render('cortesia_form', { ...pageLocals, state: 'used', link });

    const submitted = Array.isArray(req.body.people) ? req.body.people : Object.values(req.body.people || {});
    const rawPeople = Array.from({ length: link.quantity }, (_, i) => submitted[i] || {});

    const people = [];
    for (let i = 0; i < rawPeople.length; i += 1) {
      const result = validatePerson(rawPeople[i]);
      if (result.error) {
        return res.status(400).render('cortesia_form', {
          ...pageLocals,
          state: 'form',
          link,
          people: rawPeople,
          error: `Pessoa ${i + 1}: ${result.error}`,
        });
      }
      people.push(result.person);
    }

    // Claim the link atomically so a double-click or two devices can't
    // register the same invite twice.
    const now = new Date().toISOString();
    const orders = people.map((p) => ({
      id: crypto.randomUUID(),
      buyerName: p.name,
      buyerEmail: p.email,
      buyerPhone: p.phone,
      buyerCpf: p.cpf,
      quantity: 1,
      loteName: COURTESY_LOTE_NAME,
      unitPrice: 0,
      totalAmount: 0,
      status: 'pending',
      mpPaymentId: null,
      paymentMethodId: 'cortesia',
      isCourtesy: true,
      courtesyLinkId: token,
      pixQrCode: null,
      pixQrCodeBase64: null,
      createdAt: now,
      updatedAt: now,
    }));

    const claimed = await store.withDb((d) => {
      const current = (d.courtesyLinks || {})[token];
      if (!current || current.usedAt) return false;
      current.usedAt = now;
      current.orderIds = orders.map((o) => o.id);
      orders.forEach((o) => {
        d.orders[o.id] = o;
      });
      return true;
    });

    if (!claimed) {
      const fresh = (store.load().courtesyLinks || {})[token];
      return res.render('cortesia_form', { ...pageLocals, state: 'used', link: fresh || link });
    }

    try {
      for (const order of orders) {
        await approveOrder(order.id, `cortesia-${token}`, eventInfo);
      }
    } catch (err) {
      console.error(`Erro ao emitir ingressos de cortesia (link ${token}):`, err.message);
    }

    const after = store.load();
    const tickets = orders.flatMap((o) => Object.values(after.tickets).filter((t) => t.orderId === o.id));
    res.render('cortesia_done', { ...pageLocals, people, tickets });
  });

  // ---- admin ----

  app.get('/admin/cortesias', requireAdminAuth, (req, res) => {
    const db = store.load();
    const links = Object.values(db.courtesyLinks || {})
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((l) => ({
        ...l,
        url: linkUrl(l.token),
        createdAtLabel: formatDatetimeBrasiliaDisplay(l.createdAt),
        usedAtLabel: l.usedAt ? formatDatetimeBrasiliaDisplay(l.usedAt) : '',
        people: (l.orderIds || []).map((id) => db.orders[id]).filter(Boolean),
      }));
    res.render('admin_cortesias', { eventInfo, links, error: req.query.erro || null });
  });

  app.post('/admin/cortesias', requireAdminAuth, async (req, res) => {
    const label = String(req.body.label || '').trim().slice(0, 80);
    const quantity = parseInt(req.body.quantity, 10);
    if (!label || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PEOPLE_PER_LINK) {
      return res.redirect(`/admin/cortesias?erro=${encodeURIComponent(`Informe um nome e uma quantidade de 1 a ${MAX_PEOPLE_PER_LINK}.`)}`);
    }
    const token = crypto.randomBytes(9).toString('base64url');
    await store.withDb((d) => {
      d.courtesyLinks = d.courtesyLinks || {};
      d.courtesyLinks[token] = {
        token,
        label,
        quantity,
        createdAt: new Date().toISOString(),
        usedAt: null,
        orderIds: [],
      };
    });
    res.redirect('/admin/cortesias');
  });

  app.post('/admin/cortesias/:token/excluir', requireAdminAuth, async (req, res) => {
    await store.withDb((d) => {
      const link = (d.courtesyLinks || {})[req.params.token];
      // Only unused links can be removed — once tickets exist they must
      // never be invalidated.
      if (link && !link.usedAt) delete d.courtesyLinks[req.params.token];
    });
    res.redirect('/admin/cortesias');
  });
}

module.exports = { registerCortesiaRoutes, COURTESY_LOTE_NAME };
