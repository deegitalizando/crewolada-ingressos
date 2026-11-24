const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const store = require('./store');
const { currentEvent } = require('./event');

// ---------------------------------------------------------------------------
// Campanha por e-mail (/admin/mensagens): a good-looking HTML e-mail (event
// flyer, date/place, "buy" button) sent to EVERY contact the site knows:
// buyers and their companions, free sign-ups, music orders, raffle entries,
// survey answers, "levar a Crewolada" contacts and affiliates. Deduplicated by
// e-mail, never to who unsubscribed (link at the bottom of every e-mail).
//
// The e-mail itself is sent by the n8n webhook "crewolada-email-campanha"
// (Gmail node in HTML mode), one at a time, every `intervaloSeg` and up to
// `limiteDiario` a day, so Gmail doesn't flag the account.
// ---------------------------------------------------------------------------

const TICK_MS = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseUrl = () => (process.env.BASE_URL || 'https://crewolada.com').replace(/\/$/, '');
const webhookUrl = () => process.env.N8N_EMAIL_CAMPANHA_WEBHOOK_URL || 'https://n8n-n8n.wmbyj1.easypanel.host/webhook/crewolada-email-campanha';
const diaBrasilia = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
const int = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : d; };

function getEC(db) {
  const e = db.emailCampanha || {};
  const c = e.config || {};
  return {
    config: { intervaloSeg: int(c.intervaloSeg, 3, 600, 10), limiteDiario: int(c.limiteDiario, 1, 5000, 450) },
    segredo: e.segredo || '',
    optout: Array.isArray(e.optout) ? e.optout : [],
    envios: Array.isArray(e.envios) ? e.envios : [],
    enviosDia: e.enviosDia && typeof e.enviosDia === 'object' ? e.enviosDia : {},
    proximoEnvioEm: e.proximoEnvioEm || null,
  };
}

async function mutate(fn) {
  return store.withDb((db) => {
    const ec = getEC(db);
    if (!ec.segredo) ec.segredo = crypto.randomBytes(24).toString('hex');
    const out = fn(ec, db);
    db.emailCampanha = ec;
    return out;
  });
}

// ---------------------------------------------------------------- contacts

function lerAfiliados() {
  try {
    const f = path.join(__dirname, '..', 'data', 'afiliados.json');
    return Object.values((JSON.parse(fs.readFileSync(f, 'utf8')) || {}).afiliados || {});
  } catch (err) {
    return [];
  }
}

// Everyone with an e-mail, from every part of the site. Returns [{ email, nome, origem }].
function todosContatos(db) {
  const map = new Map();
  const add = (email, nome, origem) => {
    const e = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 120) return;
    const prev = map.get(e);
    if (prev) { if (!prev.nome && nome) prev.nome = String(nome).trim(); return; }
    map.set(e, { email: e, nome: String(nome || '').trim().slice(0, 80), origem });
  };
  Object.values(db.orders || {}).forEach((o) => {
    if (o.loteName === 'Lote Teste') return;
    add(o.buyerEmail, o.buyerName, o.status === 'paid' ? 'comprador' : 'interessado');
  });
  Object.values(db.tickets || {}).forEach((t) => add(t.participantEmail, t.participantName, 'participante'));
  Object.values(db.musicaPedidos || {}).forEach((p) => add(p.email, p.nome, 'musica'));
  const s = db.sorteio || {};
  Object.values(s.inscritos || {}).forEach((i) => add(i.email, i.nome, 'sorteio'));
  (s.arquivados || []).forEach((a) => Object.values((a && a.inscritos) || {}).forEach((i) => add(i.email, i.nome, 'sorteio')));
  Object.values(db.pesquisa || {}).forEach((r) => add(r.email, r.nome, 'pesquisa'));
  Object.values(db.contatos || {}).forEach((c) => add(c.email, c.nome, 'contato'));
  lerAfiliados().forEach((a) => add(a.email, a.nome, 'afiliado'));
  const optout = new Set(getEC(db).optout);
  return [...map.values()].filter((c) => !optout.has(c.email));
}

// ---------------------------------------------------------------- e-mail

function flyerPadrao(ev = currentEvent) {
  if (ev.flyer) return /^https?:/.test(ev.flyer) ? ev.flyer : baseUrl() + ev.flyer;
  return baseUrl() + (ev.theme === 'reveillon' ? '/img/flyer-pre-reveillon.jpg' : '/img/flyer.png');
}
function linkPadrao(ev = currentEvent) {
  return ev.paths && ev.paths[0] ? `${baseUrl()}/${ev.paths[0]}` : `${baseUrl()}/ingressos`;
}

function padroes() {
  const ev = currentEvent;
  return {
    assunto: `🔥 ${ev.name}: ${ev.dateLabel}${ev.timeLabel ? ` às ${ev.timeLabel}` : ''}`,
    titulo: ev.name,
    texto: `Oi {{nome}}! 🖤\n\nA próxima Crewolada já tem data: ${ev.dateLabel}${ev.timeLabel ? `, às ${ev.timeLabel}` : ''}, no ${String(ev.venue || '').split(' - ')[0]}. Uma noite de Black Music Cristã, louvor e muita celebração com a nossa família.\n\nOs ingressos já estão à venda no site, no Pix ou no cartão. Garanta o seu antes que o lote vire!`,
    flyerUrl: flyerPadrao(ev),
    botaoTexto: 'Garantir meu ingresso',
    botaoUrl: linkPadrao(ev),
  };
}

function tokenSair(segredo, email) {
  return crypto.createHmac('sha256', segredo || 'x').update(String(email).toLowerCase()).digest('hex').slice(0, 24);
}

function montarHtml(c, { nome, email, segredo }) {
  const ev = currentEvent;
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  const texto = String(c.texto || '').replace(/{{\s*nome\s*}}/g, primeiro).replace(/{{\s*\w+\s*}}/g, '').trim();
  const paragrafos = texto.split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#f5f0e6">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const sair = `${baseUrl()}/email/sair?e=${encodeURIComponent(email)}&t=${tokenSair(segredo, email)}`;
  const linha = (rotulo, valor) => (valor ? `<tr><td style="padding:6px 0;color:#a8a29a;font-size:13px;width:70px">${rotulo}</td><td style="padding:6px 0;color:#f5f0e6;font-size:15px;font-weight:700">${esc(valor)}</td></tr>` : '');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.assunto)}</title></head>
<body style="margin:0;padding:0;background:#000">
<div style="display:none;max-height:0;overflow:hidden">${esc(texto.slice(0, 120))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#121212;border:1px solid #3a2e14;border-radius:14px;overflow:hidden;font-family:Segoe UI,Helvetica,Arial,sans-serif">
  <tr><td align="center" style="padding:22px 20px 14px"><img src="${baseUrl()}/img/logo.jpg" width="64" height="64" alt="Crewolada" style="border-radius:50%;display:block"></td></tr>
  ${c.flyerUrl ? `<tr><td style="padding:0 20px"><a href="${esc(c.botaoUrl)}"><img src="${esc(c.flyerUrl)}" width="520" alt="${esc(c.titulo)}" style="width:100%;max-width:520px;height:auto;display:block;border-radius:10px;border:0"></a></td></tr>` : ''}
  <tr><td style="padding:24px 28px 4px">
    <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#f4b942;text-transform:uppercase;letter-spacing:.03em">${esc(c.titulo)}</h1>
    ${paragrafos}
  </td></tr>
  <tr><td style="padding:0 28px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:10px;padding:10px 16px">
      ${linha('Data', `${ev.dateLabel}${ev.timeLabel ? ` · ${ev.timeLabel}` : ''}`)}${linha('Local', ev.venue)}
    </table>
  </td></tr>
  ${c.botaoUrl ? `<tr><td align="center" style="padding:26px 28px 8px"><a href="${esc(c.botaoUrl)}" style="display:inline-block;background:#f4b942;color:#1a1200;text-decoration:none;font-weight:800;font-size:16px;text-transform:uppercase;letter-spacing:.03em;padding:16px 30px;border-radius:10px">${esc(c.botaoTexto || 'Garantir meu ingresso')}</a></td></tr>` : ''}
  <tr><td align="center" style="padding:10px 28px 26px;color:#a8a29a;font-size:13px">Pix ou cartão · ingresso com QR Code no e-mail e no WhatsApp</td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #2a2a2a;color:#77716a;font-size:12px;line-height:1.5" align="center">
    Você recebeu este e-mail porque participou ou se cadastrou em algo da Crewolada.<br>
    <a href="https://instagram.com/festacrewolada" style="color:#a8a29a">Instagram</a> · <a href="${baseUrl()}" style="color:#a8a29a">crewolada.com</a> · <a href="${sair}" style="color:#a8a29a">Não quero mais receber e-mails</a>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function montarTexto(c, { nome, email, segredo }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  return `${String(c.texto || '').replace(/{{\s*nome\s*}}/g, primeiro)}\n\n${c.botaoTexto}: ${c.botaoUrl}\n\nPara não receber mais: ${baseUrl()}/email/sair?e=${encodeURIComponent(email)}&t=${tokenSair(segredo, email)}`;
}

async function enviarEmail(conteudo, { email, nome }, segredo) {
  const { data } = await axios.post(webhookUrl(), {
    email, nome, assunto: conteudo.assunto,
    html: montarHtml(conteudo, { nome, email, segredo }),
    texto: montarTexto(conteudo, { nome, email, segredo }),
  }, { timeout: 30000 });
  if (data && data.ok === false) throw new Error(data.erro || 'n8n recusou o envio');
}

// ---------------------------------------------------------------- queue

let nextWakeAt = 0;
let running = false;

async function tick() {
  if (running || Date.now() < nextWakeAt) return;
  running = true;
  try {
    const db = store.load();
    const ec = getEC(db);
    const envio = ec.envios.find((e) => e.status === 'enviando' && (e.fila || []).some((f) => f.status === 'pendente'));
    if (!envio) {
      const terminou = ec.envios.find((e) => e.status === 'enviando');
      if (terminou) await mutate((x) => { const e = x.envios.find((y) => y.id === terminou.id); if (e) { e.status = 'concluido'; e.concluidoEm = new Date().toISOString(); } });
      nextWakeAt = Date.now() + 60000;
      return;
    }
    const quando = Date.parse(ec.proximoEnvioEm || 0) || 0;
    if (quando > Date.now()) { nextWakeAt = quando; return; }
    const hoje = diaBrasilia();
    if ((ec.enviosDia[hoje] || 0) >= ec.config.limiteDiario) { nextWakeAt = Date.now() + 30 * 60000; return; }
    const item = envio.fila.find((f) => f.status === 'pendente');
    let status = 'enviado';
    let erro = '';
    if (ec.optout.includes(item.email)) status = 'saiu';
    else {
      try { await enviarEmail(envio.conteudo, item, ec.segredo); } catch (err) { status = 'falha'; erro = (err.response && err.response.status ? `HTTP ${err.response.status} ` : '') + err.message; }
    }
    const espera = ec.config.intervaloSeg * 1000 * (0.8 + Math.random() * 0.4);
    await mutate((x) => {
      const e = x.envios.find((y) => y.id === envio.id);
      if (!e) return;
      const f = e.fila.find((y) => y.email === item.email && y.status === 'pendente');
      if (f) { f.status = status; if (erro) f.erro = erro; }
      e.enviados = e.fila.filter((y) => y.status === 'enviado').length;
      e.falhas = e.fila.filter((y) => y.status === 'falha').length;
      if (status === 'enviado') x.enviosDia[hoje] = (x.enviosDia[hoje] || 0) + 1;
      // Many failures in a row means the n8n webhook is down: pause instead of burning the list.
      const ultimas = e.fila.filter((y) => y.status !== 'pendente').slice(-5);
      if (ultimas.length === 5 && ultimas.every((y) => y.status === 'falha')) { e.status = 'pausado'; e.aviso = `Pausado: 5 falhas seguidas (${erro}). Confira o webhook do n8n e clique em Retomar.`; }
      x.proximoEnvioEm = new Date(Date.now() + espera).toISOString();
    });
    nextWakeAt = Date.now() + espera;
  } catch (err) {
    console.error('[emailCampanha] erro:', err.message);
    nextWakeAt = Date.now() + 60000;
  } finally {
    running = false;
  }
}

function lerConteudo(b) {
  const p = padroes();
  const url = (v, d) => (/^https?:\/\//.test(String(v || '').trim()) ? String(v).trim().slice(0, 500) : d);
  return {
    assunto: String(b.assunto || '').trim().slice(0, 150) || p.assunto,
    titulo: String(b.titulo || '').trim().slice(0, 100) || p.titulo,
    texto: String(b.texto || '').replace(/\r/g, '').trim().slice(0, 4000) || p.texto,
    flyerUrl: url(b.flyerUrl, p.flyerUrl),
    botaoTexto: String(b.botaoTexto || '').trim().slice(0, 40) || p.botaoTexto,
    botaoUrl: url(b.botaoUrl, p.botaoUrl),
  };
}

function resumo(db) {
  const ec = getEC(db);
  return {
    config: ec.config,
    total: todosContatos(db).length,
    optout: ec.optout.length,
    enviadosHoje: ec.enviosDia[diaBrasilia()] || 0,
    padroes: padroes(),
    envios: ec.envios.slice(0, 10).map((e) => ({ ...e, fila: undefined, pendentes: (e.fila || []).filter((f) => f.status === 'pendente').length, ultimasFalhas: (e.fila || []).filter((f) => f.status === 'falha').slice(-3) })),
  };
}

function registerEmailCampanhaRoutes(app, { requireAdminAuth }) {
  setInterval(() => { tick(); }, TICK_MS).unref();

  app.post('/admin/email-campanha/previa', requireAdminAuth, (req, res) => {
    res.type('html').send(montarHtml(lerConteudo(req.body), { nome: 'Maria Silva', email: 'exemplo@email.com', segredo: 'previa' }));
  });

  app.post('/api/admin/email-campanha/teste', requireAdminAuth, async (req, res) => {
    const email = String(req.body.emailTeste || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.redirect('/admin/mensagens?emailErro=' + encodeURIComponent('E-mail de teste inválido.') + '#email');
    const segredo = await mutate((ec) => ec.segredo);
    try {
      await enviarEmail(lerConteudo(req.body), { email, nome: 'Teste' }, segredo);
      return res.redirect('/admin/mensagens?emailOk=' + encodeURIComponent(`Teste enviado para ${email}.`) + '#email');
    } catch (err) {
      return res.redirect('/admin/mensagens?emailErro=' + encodeURIComponent(`O teste falhou: ${err.message}. O webhook "crewolada-email-campanha" existe e está ativo no n8n?`) + '#email');
    }
  });

  app.post('/api/admin/email-campanha', requireAdminAuth, async (req, res) => {
    const conteudo = lerConteudo(req.body);
    const total = await mutate((ec, db) => {
      if (ec.envios.some((e) => e.status === 'enviando')) return -1;
      const fila = todosContatos(db).map((c) => ({ ...c, status: 'pendente' }));
      ec.envios.unshift({ id: crypto.randomUUID(), conteudo, status: 'enviando', total: fila.length, enviados: 0, falhas: 0, fila, criadoEm: new Date().toISOString() });
      ec.envios = ec.envios.slice(0, 20);
      return fila.length;
    });
    if (total < 0) return res.redirect('/admin/mensagens?emailErro=' + encodeURIComponent('Já tem uma campanha de e-mail enviando. Espere terminar ou pause/cancele.') + '#email');
    nextWakeAt = 0;
    return res.redirect('/admin/mensagens?emailOk=' + encodeURIComponent(`Campanha iniciada para ${total} contatos.`) + '#email');
  });

  app.post('/api/admin/email-campanha/config', requireAdminAuth, async (req, res) => {
    await mutate((ec, db) => {
      db.emailCampanha = db.emailCampanha || {};
      ec.config = { intervaloSeg: int(req.body.intervaloSeg, 3, 600, ec.config.intervaloSeg), limiteDiario: int(req.body.limiteDiario, 1, 5000, ec.config.limiteDiario) };
    });
    nextWakeAt = 0;
    res.redirect('/admin/mensagens?emailOk=' + encodeURIComponent('Ajustes salvos.') + '#email');
  });

  app.post('/api/admin/email-campanha/:id/:acao', requireAdminAuth, async (req, res) => {
    await mutate((ec) => {
      const e = ec.envios.find((x) => x.id === req.params.id);
      if (!e) return;
      if (req.params.acao === 'pausar' && e.status === 'enviando') e.status = 'pausado';
      if (req.params.acao === 'retomar' && e.status === 'pausado') {
        e.status = 'enviando'; delete e.aviso;
        e.fila.forEach((f) => { if (f.status === 'falha') { f.status = 'pendente'; delete f.erro; } });
      }
      if (req.params.acao === 'cancelar' && ['enviando', 'pausado'].includes(e.status)) e.status = 'cancelado';
    });
    nextWakeAt = 0;
    res.redirect('/admin/mensagens#email');
  });

  // Unsubscribe link at the bottom of every campaign e-mail.
  app.get('/email/sair', async (req, res) => {
    const email = String(req.query.e || '').trim().toLowerCase();
    const ec = getEC(store.load());
    const ok = EMAIL_RE.test(email) && ec.segredo && String(req.query.t || '') === tokenSair(ec.segredo, email);
    if (ok) await mutate((x) => { if (!x.optout.includes(email)) x.optout.push(email); });
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crewolada</title></head><body style="margin:0;background:#000;color:#f5f0e6;font-family:Segoe UI,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px"><div><img src="/img/logo.jpg" width="72" style="border-radius:50%"><h2 style="color:#f4b942">${ok ? 'Pronto!' : 'Link inválido'}</h2><p>${ok ? `O e-mail ${esc(email)} não vai mais receber nossas campanhas.` : 'Não conseguimos confirmar este link.'}</p><p><a href="/" style="color:#f4b942">crewolada.com</a></p></div></body></html>`);
  });
}

module.exports = { registerEmailCampanhaRoutes, resumo, todosContatos, montarHtml, _internals: { padroes, lerConteudo } };
