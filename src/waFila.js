const crypto = require('crypto');
const axios = require('axios');
const store = require('./store');
const { sendReminder, normalizePhone } = require('./n8n');
const { renderTemplate } = require('./templates');

// ---------------------------------------------------------------------------
// Fila protegida de WhatsApp: lembretes e campanhas de /admin/mensagens.
//
// What gets a WhatsApp number banned is a burst of identical messages to many
// people at a machine pace. So every mass send goes through this queue:
//   - one message at a time, every `intervaloSeg` (default 2 min, editable),
//     with random +/- `variacaoPct` so the rhythm is never mechanical;
//   - only inside the daily window (default 9h-21h Brasilia) and up to
//     `limiteDiario` messages a day; what doesn't fit waits for the next window;
//   - several different versions of each message: written by the admin with
//     "|||", or generated (AI through n8n, or local rewording as a fallback),
//     and never the same version twice in a row;
//   - never twice to the same number in the same send, never to who opted out
//     (SAIR, list in /admin/automacoes).
// Each queued item is one call to the n8n reminder webhook (WhatsApp + e-mail);
// people without WhatsApp get their e-mail at once, outside the queue.
// ---------------------------------------------------------------------------

const TZ = 'America/Sao_Paulo';
const TICK_MS = 15000;
const MAX_ITENS = 4000;

const DEFAULTS = {
  intervaloSeg: 120,
  variacaoPct: 20,
  janelaInicio: 9,
  janelaFim: 21,
  limiteDiario: 150,
  versoes: 5,
  iaAtiva: true,
  pausado: false,
};

const int = (v, min, max, d) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : d;
};

function getConfig(db) {
  const c = (db.waEnvio && db.waEnvio.config) || {};
  return {
    intervaloSeg: int(c.intervaloSeg, 30, 3600, DEFAULTS.intervaloSeg),
    variacaoPct: int(c.variacaoPct, 0, 60, DEFAULTS.variacaoPct),
    janelaInicio: int(c.janelaInicio, 0, 23, DEFAULTS.janelaInicio),
    janelaFim: int(c.janelaFim, 0, 24, DEFAULTS.janelaFim) % 24,
    limiteDiario: int(c.limiteDiario, 1, 2000, DEFAULTS.limiteDiario),
    versoes: int(c.versoes, 1, 10, DEFAULTS.versoes),
    iaAtiva: c.iaAtiva !== false,
    pausado: c.pausado === true,
  };
}

function parseConfig(body, atual) {
  return {
    intervaloSeg: int(body.intervaloSeg, 30, 3600, atual.intervaloSeg),
    variacaoPct: int(body.variacaoPct, 0, 60, atual.variacaoPct),
    janelaInicio: int(body.janelaInicio, 0, 23, atual.janelaInicio),
    janelaFim: int(body.janelaFim, 0, 24, atual.janelaFim) % 24,
    limiteDiario: int(body.limiteDiario, 1, 2000, atual.limiteDiario),
    versoes: int(body.versoes, 1, 10, atual.versoes),
    iaAtiva: body.iaAtiva === 'on',
    pausado: atual.pausado,
  };
}

function getFila(db) {
  const f = db.waEnvio || {};
  return {
    config: f.config || {},
    itens: Array.isArray(f.itens) ? f.itens : [],
    lotes: Array.isArray(f.lotes) ? f.lotes : [],
    enviosDia: f.enviosDia && typeof f.enviosDia === 'object' ? f.enviosDia : {},
    proximoEnvioEm: f.proximoEnvioEm || null,
  };
}

const diaBrasilia = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const horaBrasilia = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d)) % 24;

function dentroDaJanela(cfg, d = new Date()) {
  const h = horaBrasilia(d);
  if (cfg.janelaInicio === cfg.janelaFim) return true;
  if (cfg.janelaInicio < cfg.janelaFim) return h >= cfg.janelaInicio && h < cfg.janelaFim;
  return h >= cfg.janelaInicio || h < cfg.janelaFim;
}

// ---------------------------------------------------------------------------
// Versoes da mensagem
// ---------------------------------------------------------------------------

const splitVersoes = (t) => String(t || '').split('|||').map((s) => s.trim()).filter(Boolean);

const SAUDACOES = ['Oi {{nome}}!', 'Olá, {{nome}}!', 'E aí, {{nome}}!', 'Oii {{nome}}, tudo bem?', '{{nome}}, tudo certo?', 'Fala, {{nome}}!'];
const FECHOS = ['', ' 🖤', ' 🎉', ' 🔥', ' ✨', ' 🙌'];
const TROCAS = [
  [/\bnão esqueça\b/gi, 'lembre'], [/\bnao esqueca\b/gi, 'lembre'],
  [/\bnos vemos\b/gi, 'te esperamos'], [/\bgaranta\b/gi, 'garante'],
  [/\bfaltam s[oó]\b/gi, 'faltam apenas'], [/\bamanh[aã] [eé] o grande dia\b/gi, 'amanhã é o dia'],
  [/\bhoje [eé] o dia\b/gi, 'chegou o dia'], [/\bpode vir chegando\b/gi, 'já pode vir'],
];
const SAUDACAO_RE = /^\s*(oi+|ol[aá]|e a[ií]|fala|hey|opa)\b[^!?.\n]*[!?.,]?\s*/i;

// Local rewording used when the AI is off or unavailable: swaps the greeting,
// a few common phrases and the closing emoji, so versions still differ.
function versoesLocais(texto, n) {
  const base = String(texto || '').trim();
  if (!base) return [];
  const corpo = base.replace(SAUDACAO_RE, '');
  const temSaudacao = corpo !== base;
  const out = new Set([base]);
  for (let i = 0; out.size < n && i < n * 6; i++) {
    let t = corpo;
    TROCAS.forEach(([re, sub]) => {
      if ((i + sub.length) % 2 === 0) t = t.replace(re, (m) => (m[0] === m[0].toUpperCase() ? sub.charAt(0).toUpperCase() + sub.slice(1) : sub));
    });
    t = t.replace(/[\s🖤🎉🔥✨🙌]+$/u, '') + FECHOS[i % FECHOS.length];
    if (temSaudacao || i % 2 === 0) t = `${SAUDACOES[i % SAUDACOES.length]} ${t.charAt(0).toUpperCase()}${t.slice(1)}`;
    out.add(t.trim());
  }
  return [...out].slice(0, n);
}

// AI versions through the n8n webhook "crewolada-variacoes" (same Gemini credential
// as the rest of the project). Expects { variacoes: [..] }; placeholders like
// {{nome}} must survive, otherwise that version is dropped.
async function versoesIa(texto, n) {
  const url = process.env.N8N_VARIACOES_WEBHOOK_URL || 'https://n8n-n8n.wmbyj1.easypanel.host/webhook/crewolada-variacoes';
  const { data } = await axios.post(url, { mensagem: texto, quantidade: n }, { timeout: 30000 });
  const lista = Array.isArray(data) ? data : (data && (data.variacoes || data.versoes)) || [];
  const vars = (String(texto).match(/{{\s*\w+\s*}}/g) || []).map((v) => v.replace(/\s/g, ''));
  return lista
    .map((v) => String(v || '').trim())
    .filter((v) => v.length > 5 && vars.every((p) => v.replace(/\s/g, '').includes(p)));
}

// The versions for one send: the admin's own (|||) first, completed up to
// `versoes` by the AI, or by local rewording if the AI fails.
async function gerarVersoes(template, cfg) {
  const proprias = splitVersoes(template);
  if (!proprias.length) return [];
  if (proprias.length >= cfg.versoes) return proprias;
  let extras = [];
  if (cfg.iaAtiva) {
    try {
      extras = await versoesIa(proprias[0], cfg.versoes - proprias.length);
    } catch (err) {
      console.error('[waFila] variacoes por IA indisponiveis, usando reescrita local:', err.message);
    }
  }
  if (proprias.length + extras.length < cfg.versoes) {
    extras = extras.concat(versoesLocais(proprias[0], cfg.versoes + 1).slice(1));
  }
  return [...new Set([...proprias, ...extras])].slice(0, Math.max(cfg.versoes, proprias.length));
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

let nextWakeAt = 0;
let running = false;
const wake = () => { nextWakeAt = 0; };

function optoutSet(db) {
  return new Set(((db.automacoes && db.automacoes.optout) || []).map(String));
}

// destinatarios: [{ nome, whatsapp, email, vars? }]. Returns { fila, emailSo, ignorados }.
async function enfileirar({ origem, titulo, template, destinatarios, varsBase = {} }) {
  const cfg = getConfig(store.load());
  const versoes = await gerarVersoes(template, cfg);
  if (!versoes.length) return { fila: 0, emailSo: 0, ignorados: 0 };
  const loteId = crypto.randomUUID();
  const ordem = versoes.map((_, i) => i).sort(() => Math.random() - 0.5);
  let k = 0;
  const render = (d) => renderTemplate(versoes[ordem[k++ % ordem.length]], { ...varsBase, ...(d.vars || {}), nome: d.nome || '' });

  const emailSo = [];
  const result = await store.withDb((db) => {
    db.waEnvio = getFila(db);
    const optout = optoutSet(db);
    const vistos = new Set();
    let fila = 0;
    let ignorados = 0;
    const agora = new Date().toISOString();
    destinatarios.forEach((d) => {
      const digits = String(d.whatsapp || '').replace(/\D/g, '');
      if (digits.length < 10) {
        if (d.email) emailSo.push({ ...d, mensagem: render(d) });
        return;
      }
      const numero = normalizePhone(digits);
      if (vistos.has(numero)) return;
      vistos.add(numero);
      if (optout.has(numero)) { ignorados += 1; return; }
      db.waEnvio.itens.push({
        id: crypto.randomUUID(), loteId, nome: d.nome || '', whatsapp: numero, email: d.email || '',
        mensagem: render(d), status: 'pendente', criadoEm: agora,
      });
      fila += 1;
    });
    db.waEnvio.lotes.unshift({ id: loteId, origem, titulo, total: fila, versoes, criadoEm: agora });
    db.waEnvio.lotes = db.waEnvio.lotes.slice(0, 50);
    // Old finished items go first when the list gets long.
    if (db.waEnvio.itens.length > MAX_ITENS) {
      const pend = db.waEnvio.itens.filter((i) => i.status === 'pendente');
      const feitos = db.waEnvio.itens.filter((i) => i.status !== 'pendente').slice(-Math.max(0, MAX_ITENS - pend.length));
      db.waEnvio.itens = [...feitos, ...pend];
    }
    return { fila, ignorados };
  });

  // No WhatsApp on file: the e-mail can go right away (it is not what gets numbers banned).
  for (const d of emailSo) {
    try {
      await sendReminder({ nome: d.nome, whatsapp: '', email: d.email, mensagem: d.mensagem });
    } catch (err) {
      console.error(`[waFila] falha no e-mail para ${d.email}:`, err.message);
    }
  }
  wake();
  return { ...result, emailSo: emailSo.length };
}

function proximaEspera(cfg) {
  const base = cfg.intervaloSeg * 1000;
  const delta = base * (cfg.variacaoPct / 100);
  return Math.round(base - delta + Math.random() * 2 * delta);
}

async function tick() {
  if (running || Date.now() < nextWakeAt) return;
  running = true;
  try {
    const db = store.load();
    const cfg = getConfig(db);
    const f = getFila(db);
    const item = f.itens.find((i) => i.status === 'pendente');
    const agora = Date.now();
    if (!item || cfg.pausado) { nextWakeAt = agora + 10 * 60000; return; }
    const quando = Date.parse(f.proximoEnvioEm || 0) || 0;
    if (quando > agora) { nextWakeAt = quando; return; }
    if (!dentroDaJanela(cfg)) { nextWakeAt = agora + 5 * 60000; return; }
    const hoje = diaBrasilia();
    if ((f.enviosDia[hoje] || 0) >= cfg.limiteDiario) { nextWakeAt = agora + 30 * 60000; return; }

    let status = 'enviado';
    let erro = '';
    if (optoutSet(db).has(item.whatsapp)) {
      status = 'ignorado';
    } else {
      try {
        await sendReminder({ nome: item.nome, whatsapp: item.whatsapp, email: item.email, mensagem: item.mensagem });
      } catch (err) {
        status = 'falha';
        erro = err.message;
      }
    }
    const espera = status === 'ignorado' ? 1000 : proximaEspera(cfg);
    await store.withDb((d) => {
      d.waEnvio = getFila(d);
      const x = d.waEnvio.itens.find((i) => i.id === item.id);
      if (x) { x.status = status; x.enviadoEm = new Date().toISOString(); if (erro) x.erro = erro; }
      if (status === 'enviado') d.waEnvio.enviosDia[hoje] = (d.waEnvio.enviosDia[hoje] || 0) + 1;
      const corte = diaBrasilia(new Date(Date.now() - 7 * 86400000));
      Object.keys(d.waEnvio.enviosDia).forEach((k) => { if (k < corte) delete d.waEnvio.enviosDia[k]; });
      d.waEnvio.proximoEnvioEm = new Date(Date.now() + espera).toISOString();
    });
    nextWakeAt = Date.now() + espera;
  } catch (err) {
    console.error('[waFila] erro no envio:', err.message);
    nextWakeAt = Date.now() + 60000;
  } finally {
    running = false;
  }
}

function startWaFilaScheduler() {
  setInterval(() => { tick(); }, TICK_MS).unref();
  setTimeout(() => { tick(); }, 5000).unref();
}

// Status for the panel: counts, today's sends and when the queue should end.
function resumo(db) {
  const cfg = getConfig(db);
  const f = getFila(db);
  const pendentes = f.itens.filter((i) => i.status === 'pendente').length;
  const hoje = f.enviosDia[diaBrasilia()] || 0;
  const porDia = Math.min(cfg.limiteDiario, Math.floor((((cfg.janelaFim - cfg.janelaInicio + 24) % 24 || 24) * 3600) / cfg.intervaloSeg));
  return {
    cfg,
    pendentes,
    enviadosHoje: hoje,
    falhas: f.itens.filter((i) => i.status === 'falha').length,
    proximoEnvioEm: f.proximoEnvioEm,
    duracaoMin: Math.round((pendentes * cfg.intervaloSeg) / 60),
    porDia,
    dias: porDia ? Math.ceil(pendentes / porDia) : 0,
    lotes: f.lotes.slice(0, 10).map((l) => {
      const its = f.itens.filter((i) => i.loteId === l.id);
      return { ...l, enviados: its.filter((i) => i.status === 'enviado').length, pendentes: its.filter((i) => i.status === 'pendente').length, falhas: its.filter((i) => i.status === 'falha').length };
    }),
  };
}

function registerWaFilaRoutes(app, { requireAdminAuth }) {
  app.post('/api/admin/whatsapp-envio/config', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      db.waEnvio = getFila(db);
      db.waEnvio.config = parseConfig(req.body, getConfig(db));
    });
    wake();
    res.redirect('/admin/mensagens?saved=1#protecao');
  });

  app.post('/api/admin/whatsapp-envio/:acao', requireAdminAuth, async (req, res) => {
    const { acao } = req.params;
    await store.withDb((db) => {
      db.waEnvio = getFila(db);
      const cfg = getConfig(db);
      if (acao === 'pausar') db.waEnvio.config = { ...cfg, pausado: true };
      if (acao === 'retomar') db.waEnvio.config = { ...cfg, pausado: false };
      if (acao === 'cancelar') db.waEnvio.itens.forEach((i) => { if (i.status === 'pendente') i.status = 'cancelado'; });
      if (acao === 'reenviar-falhas') db.waEnvio.itens.forEach((i) => { if (i.status === 'falha') { i.status = 'pendente'; delete i.erro; } });
    });
    wake();
    res.redirect('/admin/mensagens?saved=1#protecao');
  });

  // "Gerar versões" button next to each message box.
  app.post('/api/admin/mensagens/versoes', requireAdminAuth, async (req, res) => {
    const texto = splitVersoes(req.body.mensagem)[0];
    if (!texto) return res.status(400).json({ error: 'Escreva a mensagem primeiro.' });
    const cfg = getConfig(store.load());
    const versoes = await gerarVersoes(texto, { ...cfg, versoes: Math.max(cfg.versoes, 2) });
    res.json({ versoes });
  });
}

module.exports = {
  enfileirar, startWaFilaScheduler, registerWaFilaRoutes, resumo, getConfig,
  _internals: { versoesLocais, gerarVersoes, dentroDaJanela, proximaEspera },
};
