const crypto = require('crypto');
const store = require('./store');
const { getState, waRequest, waText, apiError, renderText, firstName } = require('./automacoes');
const waFila = require('./waFila');

// ---------------------------------------------------------------------------
// Varredura do WhatsApp (/admin/automacoes?aba=varredura)
//
// Reads the recent chats of the Evolution API instance and lists the ones whose
// LAST message came from the contact (nobody answered), older than X hours. Those
// that asked for their ticket are answered through the same lookup the n8n bot
// uses (/api/n8n/ingresso-por-telefone): it sends the ticket PDF and returns the
// text to reply ("Encontrei, Maria! ..." or "me manda o CPF ..."). The others can
// get a general reply. Everything selected goes out one at a time, at the pace of
// the protected WhatsApp queue (src/waFila.js), never in a burst.
// ---------------------------------------------------------------------------

const MAX_CHATS = 400;
const TICK_MS = 15000;
const PEDIU_INGRESSO = /(ingress|qr ?code|qrcode|bilhete|\bpdf\b|nao (recebi|chegou)|nao veio|comprei|minha entrada|meu convite|inscricao|inscrevi|cortesia)/;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tsOf = (m) => {
  let t = m && (m.messageTimestamp != null ? m.messageTimestamp : m.timestamp);
  if (t && typeof t === 'object') t = t.low != null ? t.low : Number(t);
  t = Number(t) || (m && Date.parse(m.createdAt || m.updatedAt) / 1000) || 0;
  return t > 1e12 ? t : t * 1000; // ms
};

function getVarredura(db) {
  const v = db.varreduraWa || {};
  return {
    status: v.status || 'nunca',
    iniciadaEm: v.iniciadaEm || null,
    concluidaEm: v.concluidaEm || null,
    erro: v.erro || '',
    progresso: v.progresso || '',
    params: v.params || { dias: 15, horas: 2 },
    mensagemGeral: v.mensagemGeral != null ? v.mensagemGeral
      : 'Oi {{primeiroNome}}! Desculpa a demora pra responder 🙏 Ainda precisa de ajuda com alguma coisa? É só me contar por aqui que eu te ajudo. 🖤',
    itens: Array.isArray(v.itens) ? v.itens : [],
    proximoEnvioEm: v.proximoEnvioEm || null,
  };
}

async function salvar(fn) {
  return store.withDb((db) => {
    const v = getVarredura(db);
    const out = fn(v, db);
    db.varreduraWa = v;
    return out;
  });
}

function numeroDoChat(chat, ultima) {
  const cand = [chat.remoteJid, chat.id, chat.remoteJidAlt, ultima && ultima.key && ultima.key.senderPn, ultima && ultima.key && ultima.key.remoteJidAlt];
  for (const c of cand) {
    const s = String(c || '');
    if (s.endsWith('@s.whatsapp.net')) return s.split('@')[0];
  }
  return '';
}

function registros(resp) {
  if (Array.isArray(resp)) return resp;
  if (resp && resp.messages) return Array.isArray(resp.messages) ? resp.messages : (resp.messages.records || []);
  if (resp && Array.isArray(resp.records)) return resp.records;
  return [];
}

async function mensagensDoChat(cfg, jid) {
  const r = await waRequest(cfg, 'post', 'chat/findMessages', { where: { key: { remoteJid: jid } }, page: 1, offset: 25, limit: 25 });
  return registros(r).sort((a, b) => tsOf(b) - tsOf(a));
}

async function rodar({ dias, horas }) {
  const cfg = getState(store.load()).config.whatsapp;
  const desde = Date.now() - dias * 86400000;
  const corte = Date.now() - horas * 3600000;
  let chats = await waRequest(cfg, 'post', 'chat/findChats', {});
  chats = (Array.isArray(chats) ? chats : (chats && chats.chats) || [])
    .filter((c) => {
      const jid = String(c.remoteJid || c.id || '');
      return jid && !jid.endsWith('@g.us') && !jid.includes('broadcast') && !jid.includes('newsletter');
    })
    .map((c) => ({ ...c, _ts: tsOf(c.lastMessage) || Date.parse(c.updatedAt || 0) || 0 }))
    .filter((c) => !c._ts || c._ts >= desde)
    .sort((a, b) => b._ts - a._ts)
    .slice(0, MAX_CHATS);

  const db = store.load();
  const optout = new Set(getState(db).optout);
  const anteriores = new Map(getVarredura(db).itens.map((i) => [i.numero, i]));
  const achados = [];
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    if (i % 10 === 0) await salvar((v) => { v.progresso = `Lendo conversa ${i + 1} de ${chats.length}…`; });
    const jid = String(chat.remoteJid || chat.id);
    let msgs;
    try {
      msgs = await mensagensDoChat(cfg, jid);
    } catch (err) {
      continue;
    }
    if (!msgs.length) continue;
    const ultima = msgs[0];
    if (!ultima.key || ultima.key.fromMe) continue; // already answered
    const quando = tsOf(ultima);
    if (quando > corte || quando < desde) continue;
    const numero = numeroDoChat(chat, ultima);
    if (!numero || optout.has(numero)) continue;
    // Everything the person wrote since our last reply (oldest first).
    const recebidas = [];
    for (const m of msgs) {
      if (m.key && m.key.fromMe) break;
      const t = waText(m.message);
      recebidas.unshift(t || `[${String(m.messageType || 'mídia').replace('Message', '')}]`);
    }
    const textos = recebidas.slice(-5);
    const pediuIngresso = PEDIU_INGRESSO.test(norm(textos.join(' ')));
    const ant = anteriores.get(numero);
    achados.push({
      id: ant && ant.status !== 'enviado' ? ant.id : crypto.randomUUID(),
      numero,
      nome: chat.pushName || ultima.pushName || chat.name || '',
      ultimaEm: new Date(quando).toISOString(),
      textos,
      pediuIngresso,
      status: ant && ['na_fila', 'ignorado'].includes(ant.status) ? ant.status : 'novo',
    });
  }
  achados.sort((a, b) => (b.pediuIngresso - a.pediuIngresso) || a.ultimaEm.localeCompare(b.ultimaEm));
  await salvar((v) => {
    // Items already answered stay listed (history); the sweep result replaces the rest.
    const enviados = v.itens.filter((i) => ['enviado', 'falha'].includes(i.status) && !achados.some((a) => a.numero === i.numero));
    v.itens = [...achados, ...enviados].slice(0, 600);
    v.status = 'concluida';
    v.concluidaEm = new Date().toISOString();
    v.progresso = `${chats.length} conversas lidas, ${achados.length} sem resposta.`;
    v.erro = '';
  });
}

// ---------------------------------------------------------------------------
// Envio (um por vez, no ritmo da fila protegida)
// ---------------------------------------------------------------------------

let deps = {};
let running = false;
let nextWakeAt = 0;

async function enviarUm(item, v, cfg) {
  if (item.pediuIngresso && deps.buscarEnviarIngresso) {
    // Same as the bot: sends the ticket PDF when found and gives back the text to reply.
    const r = await deps.buscarEnviarIngresso(item.numero, item.textos.join('\n'));
    if (!r || (!r.mensagem && r.error)) throw new Error((r && r.error) || 'busca do ingresso falhou');
    const texto = r.mensagem || renderText(v.mensagemGeral, { nome: item.nome, primeiroNome: firstName(item.nome) });
    await waRequest(cfg, 'post', 'message/sendText', { number: item.numero, text: texto });
    return { resposta: texto, ingresso: Boolean(r.found) };
  }
  const texto = renderText(v.mensagemGeral, { nome: item.nome, primeiroNome: firstName(item.nome) });
  await waRequest(cfg, 'post', 'message/sendText', { number: item.numero, text: texto });
  return { resposta: texto, ingresso: false };
}

async function tick() {
  if (running || Date.now() < nextWakeAt) return;
  running = true;
  try {
    const db = store.load();
    const v = getVarredura(db);
    const item = v.itens.find((i) => i.status === 'na_fila');
    if (!item) { nextWakeAt = Date.now() + 5 * 60000; return; }
    const quando = Date.parse(v.proximoEnvioEm || 0) || 0;
    if (quando > Date.now()) { nextWakeAt = quando; return; }
    const filaCfg = waFila.getConfig(db);
    if (filaCfg.pausado) { nextWakeAt = Date.now() + 60000; return; }
    const cfg = getState(db).config.whatsapp;
    let patch;
    try {
      patch = { status: 'enviado', ...(await enviarUm(item, v, cfg)), enviadoEm: new Date().toISOString() };
    } catch (err) {
      patch = { status: 'falha', erro: apiError(err), enviadoEm: new Date().toISOString() };
    }
    const espera = waFila._internals.proximaEspera(filaCfg);
    await salvar((x) => {
      const it = x.itens.find((i) => i.id === item.id);
      if (it) Object.assign(it, patch);
      x.proximoEnvioEm = new Date(Date.now() + espera).toISOString();
    });
    nextWakeAt = Date.now() + espera;
  } catch (err) {
    console.error('[varreduraWa] erro:', err.message);
    nextWakeAt = Date.now() + 60000;
  } finally {
    running = false;
  }
}

function registerVarreduraRoutes(app, { requireAdminAuth, buscarEnviarIngresso }) {
  deps = { buscarEnviarIngresso };
  setInterval(() => { tick(); }, TICK_MS).unref();

  app.post('/admin/automacoes/varredura/rodar', requireAdminAuth, async (req, res) => {
    const dias = Math.max(1, Math.min(60, parseInt(req.body.dias, 10) || 15));
    const horas = Math.max(0, Math.min(240, Number(req.body.horas) || 0));
    const cfg = getState(store.load()).config.whatsapp;
    if (!cfg.evolutionUrl || !cfg.apiKey || !cfg.instancia) {
      return res.redirect(`/admin/automacoes?aba=varredura&erro=${encodeURIComponent('Configure a Evolution API em Conexões primeiro.')}`);
    }
    const ja = getVarredura(store.load());
    if (ja.status === 'rodando' && Date.now() - Date.parse(ja.iniciadaEm) < 10 * 60000) return res.redirect('/admin/automacoes?aba=varredura');
    await salvar((v) => { Object.assign(v, { status: 'rodando', iniciadaEm: new Date().toISOString(), erro: '', progresso: 'Buscando conversas…', params: { dias, horas } }); });
    rodar({ dias, horas }).catch((err) => salvar((v) => { v.status = 'erro'; v.erro = apiError(err); }));
    res.redirect('/admin/automacoes?aba=varredura');
  });

  app.post('/admin/automacoes/varredura/enviar', requireAdminAuth, async (req, res) => {
    const ids = [].concat(req.body.ids || []);
    const mensagemGeral = String(req.body.mensagemGeral || '').trim().slice(0, 2000);
    const n = await salvar((v) => {
      if (mensagemGeral) v.mensagemGeral = mensagemGeral;
      let c = 0;
      v.itens.forEach((i) => { if (ids.includes(i.id) && ['novo', 'falha'].includes(i.status)) { i.status = 'na_fila'; delete i.erro; c += 1; } });
      return c;
    });
    nextWakeAt = 0;
    res.redirect(`/admin/automacoes?aba=varredura&msg=${encodeURIComponent(`${n} conversa(s) na fila de resposta.`)}`);
  });

  app.post('/admin/automacoes/varredura/:id/:acao', requireAdminAuth, async (req, res) => {
    await salvar((v) => {
      const it = v.itens.find((i) => i.id === req.params.id);
      if (!it) return;
      if (req.params.acao === 'ignorar' && it.status !== 'enviado') it.status = 'ignorado';
      if (req.params.acao === 'restaurar' && it.status === 'ignorado') it.status = 'novo';
      if (req.params.acao === 'tirar' && it.status === 'na_fila') it.status = 'novo';
    });
    res.redirect('/admin/automacoes?aba=varredura');
  });
}

module.exports = { registerVarreduraRoutes, getVarredura, _internals: { tsOf, PEDIU_INGRESSO, norm } };
