const crypto = require('crypto');
const store = require('./store');

// Audience survey ("pesquisa de publico"). Answers live in db.pesquisa keyed by
// id, one entry per WhatsApp number (a second submission updates the first, so
// the same person is never counted twice).
const OPCOES = {
  faixaEtaria: ['Menos de 18 anos', '18 a 24 anos', '25 a 34 anos', '35 a 44 anos', '45 a 54 anos', '55 anos ou mais'],
  genero: ['Mulher', 'Homem', 'Outro / prefiro não dizer'],
  cristao: ['Sim', 'Não', 'Prefiro não responder'],
  frequentaIgreja: ['Sim', 'Não'],
  conheceFesta: ['Já participei', 'Conheço, mas nunca fui', 'Conheci agora'],
  edicoes: ['Nenhuma', '1 edição', '2 a 3 edições', '4 ou mais'],
  comoConheceu: ['Instagram', 'Amigos ou família', 'Igreja', 'WhatsApp', 'Anúncio pago', 'Outro'],
};

const CIDADES_SUGERIDAS = [
  'Rio de Janeiro', 'Duque de Caxias', 'Nova Iguaçu', 'São Gonçalo', 'Niterói', 'Belford Roxo',
  'São João de Meriti', 'Mesquita', 'Nilópolis', 'Queimados', 'Japeri', 'Itaguaí', 'Seropédica',
];

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 20;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_MAX;
}

const digits = (v) => String(v || '').replace(/\D/g, '');
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const pick = (v, list) => (list.includes(String(v || '')) ? String(v) : '');
const phoneKey = (v) => {
  const d = digits(v);
  return d.length >= 10 ? d.slice(-10) : '';
};
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function validate(body) {
  const v = {
    nome: clean(body.nome, 80),
    whatsapp: digits(body.whatsapp),
    email: clean(body.email, 120).toLowerCase(),
    faixaEtaria: pick(body.faixaEtaria, OPCOES.faixaEtaria),
    genero: pick(body.genero, OPCOES.genero),
    cristao: pick(body.cristao, OPCOES.cristao),
    frequentaIgreja: pick(body.frequentaIgreja, OPCOES.frequentaIgreja),
    igreja: clean(body.igreja, 80),
    cidade: clean(body.cidade, 60),
    bairro: clean(body.bairro, 60),
    conheceFesta: pick(body.conheceFesta, OPCOES.conheceFesta),
    edicoes: pick(body.edicoes, OPCOES.edicoes),
    comoConheceu: pick(body.comoConheceu, OPCOES.comoConheceu),
    nps: body.nps !== undefined && body.nps !== '' && Number.isInteger(Number(body.nps)) && Number(body.nps) >= 0 && Number(body.nps) <= 10 ? Number(body.nps) : null,
    sugestao: clean(body.sugestao, 400),
    critica: clean(body.critica, 600),
    instagram: clean(body.instagram, 40).replace(/^@+/, ''),
    aceitaNovidades: body.aceitaNovidades === 'on' || body.aceitaNovidades === '1',
    consent: body.consent === 'on' || body.consent === '1',
    origem: clean(body.origem, 30).toLowerCase().replace(/[^a-z0-9_-]/g, ''),
  };

  // Conditional questions: drop answers that don't apply, so stale values
  // from a previous selection never end up stored.
  if (v.frequentaIgreja !== 'Sim') v.igreja = '';
  if (v.conheceFesta !== 'Já participei') {
    v.edicoes = 'Nenhuma';
    v.nps = null;
  }

  const errors = [];
  if (v.nome.length < 2) errors.push('Informe seu nome.');
  if (v.whatsapp.length < 10 || v.whatsapp.length > 13) errors.push('Informe um WhatsApp válido, com DDD.');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.push('O e-mail informado não parece válido.');
  if (!v.faixaEtaria) errors.push('Escolha sua faixa etária.');
  if (!v.genero) errors.push('Escolha uma opção em "Você é".');
  if (!v.cristao) errors.push('Responda se você é cristão.');
  if (!v.frequentaIgreja) errors.push('Responda se você frequenta alguma igreja.');
  if (!v.cidade) errors.push('Informe a cidade onde você mora.');
  if (!v.conheceFesta) errors.push('Conte se você já conhece a festa.');
  if (v.conheceFesta === 'Já participei' && !v.edicoes) errors.push('Escolha em quantas edições você já participou.');
  if (!v.consent) errors.push('Para enviar, é preciso concordar com o uso das informações.');

  return { values: v, errors };
}

// ---------------------------------------------------------------------------
// Admin summary
// ---------------------------------------------------------------------------

function tally(list, field, order) {
  const map = {};
  list.forEach((r) => {
    const k = r[field];
    if (!k) return;
    map[k] = (map[k] || 0) + 1;
  });
  const keys = order ? order.filter((o) => map[o] !== undefined) : Object.keys(map).sort((a, b) => map[b] - map[a]);
  return keys.map((k) => ({ label: k, count: map[k] }));
}

function tallyFreeText(list, field, limit) {
  const map = {};
  list.forEach((r) => {
    const raw = String(r[field] || '').trim();
    if (!raw) return;
    const key = raw.toLowerCase();
    map[key] = map[key] || { label: raw, count: 0 };
    map[key].count += 1;
  });
  return Object.values(map).sort((a, b) => b.count - a.count).slice(0, limit);
}

function withPct(rows, total) {
  return rows.map((r) => ({ ...r, pct: total ? Math.round((r.count / total) * 1000) / 10 : 0 }));
}

function buildSummary(db) {
  const list = Object.values(db.pesquisa || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = list.length;

  // Cross with ticket buyers (paid, non-courtesy) by phone / e-mail.
  const orders = Object.values(db.orders || {}).filter((o) => o.status === 'paid' && !o.isCourtesy);
  const buyerPhones = new Set(orders.map((o) => phoneKey(o.buyerPhone)).filter(Boolean));
  const buyerEmails = new Set(orders.map((o) => String(o.buyerEmail || '').trim().toLowerCase()).filter(Boolean));
  const attendedOrderIds = new Set();
  Object.values(db.tickets || {}).forEach((t) => { if (t.status === 'used') attendedOrderIds.add(t.orderId); });
  const attendedPhones = new Set();
  const attendedEmails = new Set();
  orders.forEach((o) => {
    if (!attendedOrderIds.has(o.id)) return;
    attendedPhones.add(phoneKey(o.buyerPhone));
    attendedEmails.add(String(o.buyerEmail || '').trim().toLowerCase());
  });

  const rows = list.map((r) => {
    const pk = phoneKey(r.whatsapp);
    const isBuyer = (pk && buyerPhones.has(pk)) || (r.email && buyerEmails.has(r.email));
    const attended = (pk && attendedPhones.has(pk)) || (r.email && attendedEmails.has(r.email));
    return { ...r, isBuyer: Boolean(isBuyer), attended: Boolean(attended) };
  });

  const promoters = list.filter((r) => r.nps !== null && r.nps >= 9).length;
  const detractors = list.filter((r) => r.nps !== null && r.nps <= 6).length;
  const npsCount = list.filter((r) => r.nps !== null && r.nps !== undefined).length;
  const optIn = list.filter((r) => r.aceitaNovidades).length;
  const christian = list.filter((r) => r.cristao === 'Sim').length;
  const answeredChristian = list.filter((r) => r.cristao && r.cristao !== 'Prefiro não responder').length;
  const church = list.filter((r) => r.frequentaIgreja === 'Sim').length;

  return {
    total,
    rows,
    kpis: {
      total,
      buyers: rows.filter((r) => r.isBuyer).length,
      attended: rows.filter((r) => r.attended).length,
      optIn,
      christianPct: answeredChristian ? Math.round((christian / answeredChristian) * 1000) / 10 : 0,
      churchPct: total ? Math.round((church / total) * 1000) / 10 : 0,
      nps: npsCount ? Math.round(((promoters - detractors) / npsCount) * 100) : null,
      npsCount,
    },
    blocks: [
      { title: 'Faixa etária', rows: withPct(tally(list, 'faixaEtaria', OPCOES.faixaEtaria), total) },
      { title: 'Gênero', rows: withPct(tally(list, 'genero', OPCOES.genero), total) },
      { title: 'É cristão?', rows: withPct(tally(list, 'cristao', OPCOES.cristao), total) },
      { title: 'Frequenta igreja?', rows: withPct(tally(list, 'frequentaIgreja', OPCOES.frequentaIgreja), total) },
      { title: 'Já conhece a festa?', rows: withPct(tally(list, 'conheceFesta', OPCOES.conheceFesta), total) },
      { title: 'Edições que já participou', rows: withPct(tally(list, 'edicoes', OPCOES.edicoes), total) },
      { title: 'Como conheceu', rows: withPct(tally(list, 'comoConheceu', OPCOES.comoConheceu), total) },
      { title: 'Cidade onde mora (top 10)', rows: withPct(tallyFreeText(list, 'cidade', 10), total) },
      { title: 'Bairro (top 10)', rows: withPct(tallyFreeText(list, 'bairro', 10), total) },
      { title: 'Igreja (top 10)', rows: withPct(tallyFreeText(list, 'igreja', 10), total) },
      { title: 'Origem do link', rows: withPct(tally(list, 'origem'), total) },
    ].filter((b) => b.rows.length > 0),
    sugestoes: list.filter((r) => r.sugestao).slice(0, 30).map((r) => ({ nome: r.nome, texto: r.sugestao, createdAt: r.createdAt })),
    criticas: list.filter((r) => r.critica).slice(0, 50).map((r) => ({ nome: r.nome, texto: r.critica, nps: r.nps, createdAt: r.createdAt })),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function registerPesquisaRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay }) {
  const formBase = { eventInfo, opcoes: OPCOES, cidades: CIDADES_SUGERIDAS };

  app.get('/pesquisa', (req, res) => {
    const origem = clean(req.query.o || req.query.origem, 30).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    res.render('pesquisa_form', { ...formBase, errors: [], v: { origem } });
  });

  app.post('/pesquisa', async (req, res) => {
    // Honeypot: real people never fill the hidden "website" field.
    if (req.body.website) return res.render('pesquisa_obrigado', { eventInfo });
    // Behind the hosting proxy req.ip is the proxy itself, so use the forwarded client address.
    const clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    if (rateLimited(clientIp)) {
      return res.status(429).render('pesquisa_form', {
        ...formBase, errors: ['Muitas tentativas em pouco tempo. Tente de novo mais tarde.'], v: {},
      });
    }

    const { values, errors } = validate(req.body);
    if (errors.length) {
      return res.status(400).render('pesquisa_form', { ...formBase, errors, v: values });
    }

    const key = phoneKey(values.whatsapp);
    const now = new Date().toISOString();
    await store.withDb((db) => {
      db.pesquisa = db.pesquisa || {};
      const existing = Object.values(db.pesquisa).find((r) => phoneKey(r.whatsapp) === key);
      if (existing) {
        Object.assign(existing, values, { updatedAt: now, consentAt: now });
      } else {
        const id = crypto.randomUUID();
        db.pesquisa[id] = { id, ...values, createdAt: now, updatedAt: now, consentAt: now };
      }
    });

    return res.render('pesquisa_obrigado', { eventInfo });
  });

  app.get('/admin/pesquisa', requireAdminAuth, (req, res) => {
    const db = store.load();
    const summary = buildSummary(db);
    summary.rows = summary.rows.map((r) => ({ ...r, createdAtLabel: formatDatetimeBrasiliaDisplay(r.createdAt) }));
    res.render('admin_pesquisa', { eventInfo, s: summary, baseUrl: process.env.BASE_URL || '' });
  });

  app.get('/admin/pesquisa/exportar.csv', requireAdminAuth, (req, res) => {
    const db = store.load();
    const { rows } = buildSummary(db);
    const head = [
      'Data', 'Nome', 'WhatsApp', 'E-mail', 'Faixa etária', 'Gênero', 'Cristão', 'Frequenta igreja', 'Igreja',
      'Cidade', 'Bairro', 'Conhece a festa', 'Edições', 'Como conheceu', 'Nota (0-10)', 'O que quer ver', 'Crítica ou sugestão', 'Instagram',
      'Aceita novidades', 'Comprou ingresso', 'Compareceu', 'Origem do link',
    ];
    const lines = [head.map(csvCell).join(';')];
    rows.forEach((r) => {
      lines.push([
        formatDatetimeBrasiliaDisplay(r.createdAt), r.nome, r.whatsapp, r.email, r.faixaEtaria, r.genero, r.cristao,
        r.frequentaIgreja, r.igreja, r.cidade, r.bairro, r.conheceFesta, r.edicoes, r.comoConheceu,
        r.nps === null || r.nps === undefined ? '' : r.nps, r.sugestao, r.critica, r.instagram,
        r.aceitaNovidades ? 'Sim' : 'Não', r.isBuyer ? 'Sim' : 'Não', r.attended ? 'Sim' : 'Não', r.origem,
      ].map(csvCell).join(';'));
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="pesquisa-publico.csv"');
    res.send('﻿' + lines.join('\r\n'));
  });

  app.post('/admin/pesquisa/:id/excluir', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      if (db.pesquisa) delete db.pesquisa[req.params.id];
    });
    res.redirect('/admin/pesquisa');
  });
}

module.exports = { registerPesquisaRoutes, buildSummary, validate, OPCOES };
