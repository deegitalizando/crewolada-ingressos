const crypto = require('crypto');
const store = require('./store');

// Giveaway ("sorteio"). Anyone with the public link (/sorteio) signs up with
// name, e-mail and WhatsApp and gets a sequential lucky number. The admin then
// draws the winner live on a full-screen wheel (/admin/sorteio/roleta), made to
// be shown on a live video. The winner is always chosen on the server (crypto
// random), the wheel only animates towards it.
//
// db.sorteio = {
//   titulo, premio, regras, aberto, permitirRepetir,
//   proximoNumero, inscritos: { id: {...} }, ganhadores: [ {...} ], arquivados: [ {...} ]
// }

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 15;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_MAX;
}

const COOKIE = 'sorteio_id';
const digits = (v) => String(v || '').replace(/\D/g, '');
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const normalizePhone = (v) => {
  let d = digits(v).replace(/^0+/, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d;
};
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Name shown on the live video: first name + initial of the last one ("Maria S."),
// never the full name, phone or e-mail.
function nomeCurto(nome) {
  const parts = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const cap = (w) => w.charAt(0).toLocaleUpperCase('pt-BR') + w.slice(1).toLocaleLowerCase('pt-BR');
  const first = cap(parts[0]);
  if (parts.length === 1) return first;
  return `${first} ${parts[parts.length - 1].charAt(0).toLocaleUpperCase('pt-BR')}.`;
}

function getSorteio(db) {
  db.sorteio = db.sorteio || {};
  const s = db.sorteio;
  if (s.titulo === undefined) s.titulo = 'Sorteio Crewolada';
  if (s.premio === undefined) s.premio = '';
  if (s.regras === undefined) s.regras = '';
  if (s.aberto === undefined) s.aberto = true;
  if (s.permitirRepetir === undefined) s.permitirRepetir = false;
  if (!s.proximoNumero) s.proximoNumero = 1;
  s.inscritos = s.inscritos || {};
  s.ganhadores = s.ganhadores || [];
  s.arquivados = s.arquivados || [];
  return s;
}

// Read-only view of the giveaway (does not write defaults back to disk).
function readSorteio() {
  return getSorteio(store.load());
}

function digitsFor(s) {
  return Math.max(3, String(Math.max(1, s.proximoNumero - 1)).length);
}
const fmtNumero = (n, width) => String(n).padStart(width, '0');

function validate(body) {
  const v = {
    nome: clean(body.nome, 80),
    email: clean(body.email, 120).toLowerCase(),
    whatsapp: normalizePhone(body.whatsapp),
    consent: body.consent === 'on' || body.consent === '1',
    origem: clean(body.origem, 30).toLowerCase().replace(/[^a-z0-9_-]/g, ''),
  };
  const errors = [];
  if (v.nome.length < 3 || !/\s/.test(v.nome)) errors.push('Informe seu nome e sobrenome.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.push('Informe um e-mail válido.');
  if (!/^[1-9][1-9]\d{8,9}$/.test(v.whatsapp)) errors.push('Informe um WhatsApp válido, com DDD.');
  if (!v.consent) errors.push('Para participar, é preciso concordar com o regulamento.');
  return { values: v, errors };
}

function findExisting(s, { whatsapp, email }) {
  return Object.values(s.inscritos).find((i) => (whatsapp && i.whatsapp === whatsapp) || (email && i.email === email));
}

function eligible(s) {
  const won = new Set(s.ganhadores.map((g) => g.inscritoId));
  return Object.values(s.inscritos)
    .filter((i) => s.permitirRepetir || !won.has(i.id))
    .sort((a, b) => a.numero - b.numero);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function registerSorteioRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay }) {
  const publicBase = () => {
    const s = readSorteio();
    return { eventInfo, sorteio: { titulo: s.titulo, premio: s.premio, regras: s.regras, aberto: s.aberto } };
  };
  const renderNumero = (res, s, inscrito, jaInscrito) => res.render('sorteio_numero', {
    ...publicBase(),
    numero: fmtNumero(inscrito.numero, digitsFor(s)),
    nome: nomeCurto(inscrito.nome),
    jaInscrito,
  });

  app.get('/sorteio', (req, res) => {
    const s = readSorteio();
    // Someone who already signed up on this device sees their number straight away.
    const mine = s.inscritos[req.cookies[COOKIE]];
    if (mine && req.query.novo === undefined) return renderNumero(res, s, mine, true);
    const origem = clean(req.query.o || req.query.origem, 30).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    res.render('sorteio_form', { ...publicBase(), errors: [], v: { origem } });
  });

  app.post('/sorteio', async (req, res) => {
    if (req.body.website) return res.redirect('/sorteio'); // honeypot
    const clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const { values, errors } = validate(req.body);
    const formError = (status, list) => res.status(status).render('sorteio_form', { ...publicBase(), errors: list, v: values });

    if (!readSorteio().aberto) return formError(403, ['As inscrições deste sorteio estão encerradas.']);
    if (rateLimited(clientIp)) return formError(429, ['Muitas tentativas em pouco tempo. Tente de novo mais tarde.']);
    if (errors.length) return formError(400, errors);

    const now = new Date().toISOString();
    const result = await store.withDb((db) => {
      const s = getSorteio(db);
      if (!s.aberto) return { closed: true };
      const existing = findExisting(s, values);
      if (existing) return { inscrito: existing, jaInscrito: true, s };
      const id = crypto.randomUUID();
      const inscrito = {
        id,
        numero: s.proximoNumero,
        nome: values.nome,
        email: values.email,
        whatsapp: values.whatsapp,
        origem: values.origem,
        consentAt: now,
        createdAt: now,
      };
      s.proximoNumero += 1;
      s.inscritos[id] = inscrito;
      return { inscrito, jaInscrito: false, s };
    });

    if (result.closed) return formError(403, ['As inscrições deste sorteio estão encerradas.']);
    res.cookie(COOKIE, result.inscrito.id, { maxAge: 180 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax' });
    return renderNumero(res, result.s, result.inscrito, result.jaInscrito);
  });

  // ---- admin ----

  app.get('/admin/sorteio', requireAdminAuth, (req, res) => {
    const s = readSorteio();
    const width = digitsFor(s);
    const byId = s.inscritos;
    const inscritos = Object.values(s.inscritos)
      .sort((a, b) => b.numero - a.numero)
      .map((i) => ({ ...i, numeroLabel: fmtNumero(i.numero, width), createdAtLabel: formatDatetimeBrasiliaDisplay(i.createdAt) }));
    const ganhadores = s.ganhadores.map((g, idx) => ({
      ...g,
      idx,
      numeroLabel: fmtNumero(g.numero, width),
      atLabel: formatDatetimeBrasiliaDisplay(g.at),
      inscrito: byId[g.inscritoId] || null,
    }));
    res.render('admin_sorteio', {
      eventInfo,
      s,
      inscritos,
      ganhadores,
      elegiveis: eligible(s).length,
      arquivados: s.arquivados.map((a) => ({ ...a, encerradoEmLabel: formatDatetimeBrasiliaDisplay(a.encerradoEm) })),
      baseUrl: process.env.BASE_URL || '',
      flash: req.query.ok || '',
    });
  });

  app.post('/admin/sorteio/config', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      const s = getSorteio(db);
      s.titulo = clean(req.body.titulo, 80) || 'Sorteio';
      s.premio = clean(req.body.premio, 120);
      s.regras = String(req.body.regras || '').trim().slice(0, 1500);
      s.aberto = req.body.aberto === 'on' || req.body.aberto === '1';
      s.permitirRepetir = req.body.permitirRepetir === 'on' || req.body.permitirRepetir === '1';
    });
    res.redirect('/admin/sorteio?ok=salvo');
  });

  app.post('/admin/sorteio/inscritos/:id/excluir', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      const s = getSorteio(db);
      delete s.inscritos[req.params.id];
    });
    res.redirect('/admin/sorteio');
  });

  app.post('/admin/sorteio/ganhadores/:idx/remover', requireAdminAuth, async (req, res) => {
    const idx = Number(req.params.idx);
    await store.withDb((db) => {
      const s = getSorteio(db);
      if (Number.isInteger(idx) && idx >= 0 && idx < s.ganhadores.length) s.ganhadores.splice(idx, 1);
    });
    res.redirect('/admin/sorteio');
  });

  // Starts a new giveaway: the current list is archived (summary + winners) and cleared.
  app.post('/admin/sorteio/novo', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      const s = getSorteio(db);
      s.arquivados.unshift({
        titulo: s.titulo,
        premio: s.premio,
        total: Object.keys(s.inscritos).length,
        encerradoEm: new Date().toISOString(),
        ganhadores: s.ganhadores.map((g) => {
          const i = s.inscritos[g.inscritoId] || {};
          return { numero: g.numero, nome: i.nome || g.nomeCurto, whatsapp: i.whatsapp || '', email: i.email || '', at: g.at };
        }),
      });
      s.inscritos = {};
      s.ganhadores = [];
      s.proximoNumero = 1;
      s.aberto = true;
    });
    res.redirect('/admin/sorteio?ok=novo');
  });

  app.get('/admin/sorteio/exportar.csv', requireAdminAuth, (req, res) => {
    const s = readSorteio();
    const width = digitsFor(s);
    const won = new Set(s.ganhadores.map((g) => g.inscritoId));
    const lines = [['Número', 'Nome', 'E-mail', 'WhatsApp', 'Data', 'Origem', 'Ganhou'].map(csvCell).join(';')];
    Object.values(s.inscritos).sort((a, b) => a.numero - b.numero).forEach((i) => {
      lines.push([fmtNumero(i.numero, width), i.nome, i.email, i.whatsapp, formatDatetimeBrasiliaDisplay(i.createdAt), i.origem, won.has(i.id) ? 'Sim' : 'Não']
        .map(csvCell).join(';'));
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="sorteio-inscritos.csv"');
    res.send('﻿' + lines.join('\r\n'));
  });

  // Full-screen wheel for the live video.
  app.get('/admin/sorteio/roleta', requireAdminAuth, (req, res) => {
    const s = readSorteio();
    res.render('sorteio_roleta', { eventInfo, titulo: s.titulo, premio: s.premio });
  });

  // Only the short name + number ever reach the wheel page (it is on camera).
  app.get('/api/admin/sorteio/estado', requireAdminAuth, (req, res) => {
    const s = readSorteio();
    const width = digitsFor(s);
    res.json({
      titulo: s.titulo,
      premio: s.premio,
      total: Object.keys(s.inscritos).length,
      elegiveis: eligible(s).map((i) => ({ numero: fmtNumero(i.numero, width), nome: nomeCurto(i.nome) })),
      ganhadores: s.ganhadores.map((g) => ({ numero: fmtNumero(g.numero, width), nome: g.nomeCurto })),
    });
  });

  app.post('/api/admin/sorteio/sortear', requireAdminAuth, async (req, res) => {
    const result = await store.withDb((db) => {
      const s = getSorteio(db);
      const pool = eligible(s);
      if (!pool.length) return null;
      const w = pool[crypto.randomInt(pool.length)];
      const g = { inscritoId: w.id, numero: w.numero, nomeCurto: nomeCurto(w.nome), at: new Date().toISOString() };
      s.ganhadores.push(g);
      return { numero: fmtNumero(w.numero, digitsFor(s)), nome: g.nomeCurto, ordem: s.ganhadores.length };
    });
    if (!result) return res.status(409).json({ error: 'Não há participantes disponíveis para sortear.' });
    res.json(result);
  });
}

module.exports = { registerSorteioRoutes, nomeCurto, validate };
