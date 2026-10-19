const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

// ---------------------------------------------------------------------------
// Web Push for the admin's phone: "Venda aprovada" / "Música vendida" notifications.
// Keys (VAPID) are generated once and kept next to the data, so nothing has to be configured.
// Subscriptions are only ever created from the logged-in admin area.
// ---------------------------------------------------------------------------
const FILE = path.join(__dirname, '..', 'data', 'push.json');
let state = null;
let chain = Promise.resolve();

function load() {
  if (state) return state;
  try {
    const raw = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').trim() : '';
    state = raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('push.json ilegivel, recomecando:', err.message);
    state = {};
  }
  if (!state.vapid) state.vapid = webpush.generateVAPIDKeys();
  if (!state.subs) state.subs = {};
  return state;
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}
function mutate(fn) {
  chain = chain.then(() => { load(); const r = fn(state); save(); return r; });
  return chain;
}

let ready = false;
function init() {
  const s = load();
  if (!ready) {
    webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:contato@crewolada.com', s.vapid.publicKey, s.vapid.privateKey);
    ready = true;
    save(); // persists the freshly generated keys
  }
  return s;
}

const idOf = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);
const validaSub = (sub) => sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint)
  && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';

async function inscrever(sub, ua) {
  if (!validaSub(sub)) return false;
  init();
  await mutate((s) => {
    const entradas = Object.entries(s.subs);
    if (entradas.length >= 12) { // keep it small: drop the oldest
      entradas.sort((a, b) => (a[1].criadoEm || '').localeCompare(b[1].criadoEm || ''));
      delete s.subs[entradas[0][0]];
    }
    s.subs[idOf(sub.endpoint)] = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, criadoEm: new Date().toISOString(), ua: String(ua || '').slice(0, 120) };
  });
  return true;
}
async function remover(endpoint) {
  init();
  await mutate((s) => { delete s.subs[idOf(endpoint)]; });
}
const quantos = () => Object.keys(init().subs).length;
const chavePublica = () => init().vapid.publicKey;

// Sends to every registered phone. Never throws: a failed push must not break a sale.
async function notificar({ titulo, corpo, tag, url }) {
  try {
    const s = init();
    const payload = JSON.stringify({ titulo, corpo, tag: tag || 'crewolada', url: url || '/admin', som: true });
    const mortas = [];
    await Promise.all(Object.entries(s.subs).map(async ([id, item]) => {
      try {
        await webpush.sendNotification(item.sub, payload, { TTL: 3600, urgency: 'high' });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) mortas.push(id);
        else console.error('Push falhou:', err.statusCode || err.message);
      }
    }));
    if (mortas.length) await mutate((st) => { mortas.forEach((id) => delete st.subs[id]); });
    return Object.keys(s.subs).length - mortas.length;
  } catch (err) {
    console.error('Push indisponivel:', err.message);
    return 0;
  }
}

const reais = (n) => 'R$ ' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2).replace('.', ',');

// Message builders for the two kinds of sale.
function avisoIngresso(order, eventName) {
  const itens = Array.isArray(order.items) && order.items.length
    ? order.items.filter((i) => i.qty > 0).map((i) => `${i.qty}x ${i.label || i.kind}`).join(', ')
    : `${order.quantity || 1} ingresso(s)`;
  return {
    titulo: `💰 Venda aprovada: ${reais(order.totalAmount)}`,
    corpo: `${eventName ? eventName + ' · ' : ''}${order.loteName || 'Ingresso'} · ${itens}${order.buyerName ? ' · ' + order.buyerName.split(' ')[0] : ''}`,
    tag: `ingresso-${order.id}`,
    url: '/admin',
  };
}
function avisoMusica(pedido) {
  const origem = pedido.canal === 'whatsapp' ? 'WhatsApp' : 'site';
  const af = pedido.afiliacao && pedido.afiliacao.shares && pedido.afiliacao.shares.length
    ? ' · via afiliado ' + pedido.afiliacao.shares.map((x) => x.codigo).join(', ') : '';
  return {
    titulo: `🎵 Música vendida: ${reais(pedido.valor)}`,
    corpo: `${pedido.estilo || 'Música personalizada'}${pedido.vocal ? ' · vocal ' + String(pedido.vocal).toLowerCase() : ''} · ${origem}${af}`,
    tag: `musica-${pedido.id}`,
    url: '/admin/musicas',
  };
}

// ---------------------------------------------------------------------------
function registerPushRoutes(app, { requireAdminAuth, eventInfo }) {
  // /admin-sw.js, /admin.webmanifest and /audio/venda.wav are plain files in public/.

  app.get('/admin/avisos', requireAdminAuth, (req, res) => {
    res.render('admin_avisos', { eventInfo, inscritos: quantos() });
  });
  app.get('/api/admin/push/chave', requireAdminAuth, (req, res) => res.json({ chave: chavePublica(), inscritos: quantos() }));
  app.post('/api/admin/push/inscrever', requireAdminAuth, async (req, res) => {
    const ok = await inscrever(req.body && req.body.subscription, req.headers['user-agent']);
    if (!ok) return res.status(400).json({ error: 'Inscrição inválida.' });
    return res.json({ ok: true, inscritos: quantos() });
  });
  app.post('/api/admin/push/remover', requireAdminAuth, async (req, res) => {
    await remover(req.body && req.body.endpoint);
    return res.json({ ok: true, inscritos: quantos() });
  });
  app.post('/api/admin/push/testar', requireAdminAuth, async (req, res) => {
    const enviados = await notificar({ titulo: '💰 Teste: Venda aprovada: R$ 25,00', corpo: 'Tardezinha Crewolada · Ingresso Simples · 1x Adulto · Maria', tag: 'teste', url: '/admin/avisos' });
    return res.json({ ok: true, enviados });
  });
}

module.exports = { registerPushRoutes, notificar, avisoIngresso, avisoMusica, inscrever, quantos, chavePublica };
