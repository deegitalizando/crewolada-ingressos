const crypto = require('crypto');
const axios = require('axios');
const store = require('./store');
const { normalizePhone } = require('./n8n');
const { currentEvent, eventTemplateVars, EVENTS, orderEventId } = require('./event');

// ---------------------------------------------------------------------------
// Automacoes de Instagram e WhatsApp (painel /admin/automacoes)
//
// Instagram (Graph API da Meta, via webhook do app Meta):
//   - Comentario com palavra-chave -> resposta publica no comentario e/ou
//     mensagem no Direct (private reply), opcionalmente so em um post.
//   - Mensagem no Direct com palavra-chave -> resposta no Direct.
//   - Publicacoes agendadas (foto, reels ou story) via Content Publishing API.
// WhatsApp (Evolution API, webhook "messages.upsert"):
//   - Mensagem recebida com palavra-chave -> resposta (texto e/ou midia).
//   - Disparos agendados com fila, intervalo aleatorio entre envios, janela de
//     horario, limite diario, variacoes de texto e descadastro ("SAIR").
//
// Os webhooks recebidos podem ser repassados para outra URL (ex: o n8n, que ja
// roda o agente de IA), assim um unico webhook cadastrado na Meta / Evolution
// atende as duas coisas. Tudo fica em db.automacoes (data/db.json).
// ---------------------------------------------------------------------------

const MAX_LOG = 500;
const MAX_TEXT = 2000;
const TICK_MS = 15000;
const TZ = 'America/Sao_Paulo';

const GATILHOS = {
  ig_comentario: { canal: 'instagram', label: 'Comentário no Instagram' },
  ig_dm: { canal: 'instagram', label: 'Direct do Instagram' },
  wa_mensagem: { canal: 'whatsapp', label: 'Mensagem no WhatsApp' },
};
const MODOS = { contem: 'Contém a palavra', exata: 'Mensagem exata', qualquer: 'Qualquer mensagem (resposta padrão)' };

const clean = (v, max = MAX_TEXT) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nowIso = () => new Date().toISOString();
const randInt = (min, max) => Math.floor(min + Math.random() * (Math.max(min, max) - min + 1));
const mask = (v) => (v ? `${'•'.repeat(6)}${String(v).slice(-4)}` : '');
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

function getState(db) {
  const a = db.automacoes || {};
  const cfg = a.config || {};
  const ig = cfg.instagram || {};
  const wa = cfg.whatsapp || {};
  return {
    config: {
      instagram: {
        ativo: ig.ativo === true,
        igUserId: ig.igUserId || process.env.IG_USER_ID || '',
        accessToken: ig.accessToken || process.env.IG_ACCESS_TOKEN || '',
        appSecret: ig.appSecret || process.env.META_APP_SECRET || '',
        verifyToken: ig.verifyToken || process.env.IG_VERIFY_TOKEN || '',
        apiHost: ig.apiHost === 'graph.facebook.com' ? 'graph.facebook.com' : 'graph.instagram.com',
        apiVersion: /^v\d+\.\d+$/.test(ig.apiVersion || '') ? ig.apiVersion : 'v23.0',
        encaminharUrl: ig.encaminharUrl || '',
        encaminharModo: ['sempre', 'sem_regra'].includes(ig.encaminharModo) ? ig.encaminharModo : 'sempre',
      },
      whatsapp: {
        ativo: wa.ativo === true,
        evolutionUrl: (wa.evolutionUrl || process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
        apiKey: wa.apiKey || process.env.EVOLUTION_API_KEY || '',
        instancia: wa.instancia || process.env.EVOLUTION_INSTANCE || '',
        webhookToken: wa.webhookToken || '',
        encaminharUrl: wa.encaminharUrl || '',
        encaminharModo: ['sempre', 'sem_regra'].includes(wa.encaminharModo) ? wa.encaminharModo : 'sempre',
        optoutPalavras: Array.isArray(wa.optoutPalavras) ? wa.optoutPalavras : ['sair', 'parar', 'descadastrar', 'stop'],
        optoutResposta: wa.optoutResposta != null ? wa.optoutResposta : 'Pronto! Você não vai mais receber nossas mensagens automáticas. Se mudar de ideia, é só mandar VOLTAR. 🖤',
        janelaInicio: Number.isInteger(wa.janelaInicio) ? wa.janelaInicio : 9,
        janelaFim: Number.isInteger(wa.janelaFim) ? wa.janelaFim : 21,
        limiteDiario: Number.isInteger(wa.limiteDiario) ? wa.limiteDiario : 200,
      },
    },
    regras: Array.isArray(a.regras) ? a.regras : [],
    disparos: Array.isArray(a.disparos) ? a.disparos : [],
    posts: Array.isArray(a.posts) ? a.posts : [],
    contatos: a.contatos && typeof a.contatos === 'object' ? a.contatos : {},
    optout: Array.isArray(a.optout) ? a.optout : [],
    cooldown: a.cooldown && typeof a.cooldown === 'object' ? a.cooldown : {},
    enviosDia: a.enviosDia && typeof a.enviosDia === 'object' ? a.enviosDia : {},
    log: Array.isArray(a.log) ? a.log : [],
  };
}

// The resolved config (with .env fallbacks) is never written back: only the raw
// values the admin saved (db.automacoes.config, changed by the config routes) persist.
function saveState(db, state) {
  const raw = (db.automacoes && db.automacoes.config) || {};
  db.automacoes = { ...state, config: raw };
}

function rawConfig(db) {
  db.automacoes = db.automacoes || {};
  const raw = (db.automacoes.config = db.automacoes.config || {});
  raw.instagram = raw.instagram || {};
  raw.whatsapp = raw.whatsapp || {};
  return raw;
}

async function mutate(fn) {
  return store.withDb((db) => {
    const st = getState(db);
    const out = fn(st, db);
    saveState(db, st);
    return out;
  });
}

function pushLog(st, entry) {
  st.log.unshift({ id: crypto.randomUUID(), ts: nowIso(), ...entry });
  if (st.log.length > MAX_LOG) st.log.length = MAX_LOG;
}

async function log(entry) {
  try {
    await mutate((st) => pushLog(st, entry));
  } catch (err) {
    console.error('[automacoes] falha ao gravar log:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

function pickVariation(text) {
  const parts = String(text || '').split('|||').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  return parts[Math.floor(Math.random() * parts.length)];
}

function renderText(template, vars) {
  const base = { ...eventTemplateVars(currentEvent), ...vars };
  return pickVariation(template).replace(/{{\s*(\w+)\s*}}/g, (_, k) => (base[k] == null ? '' : String(base[k])));
}

function firstName(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

function parsePalavras(raw) {
  return String(raw || '')
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function matchesRule(rule, text) {
  const t = norm(text);
  if (rule.modo === 'qualquer') return true;
  return (rule.palavras || []).some((p) => {
    const k = norm(p);
    if (!k) return false;
    if (rule.modo === 'exata') return t === k || t.replace(/[!?.,]+$/, '') === k;
    return new RegExp(`(^|[^a-z0-9])${escapeRe(k)}($|[^a-z0-9])`).test(t);
  });
}

// The first active rule (in list order) that matches; catch-all rules only if nothing else does.
function findRule(regras, gatilho, text, { midiaId } = {}) {
  const candidates = regras.filter((r) => r.ativo && r.gatilho === gatilho && (!r.midiaId || !midiaId || r.midiaId === midiaId));
  return candidates.find((r) => r.modo !== 'qualquer' && matchesRule(r, text))
    || candidates.find((r) => r.modo === 'qualquer')
    || null;
}

// ---------------------------------------------------------------------------
// Clientes das APIs
// ---------------------------------------------------------------------------

function igBase(ig) {
  return (process.env.IG_API_BASE || `https://${ig.apiHost}`).replace(/\/$/, '') + `/${ig.apiVersion}`;
}

function apiError(err) {
  const d = err.response && err.response.data;
  if (d && d.error) return d.error.message || JSON.stringify(d.error).slice(0, 300);
  if (d && (d.message || d.response)) return JSON.stringify(d.message || d.response).slice(0, 300);
  return err.message;
}

async function igRequest(ig, method, pathName, data, params = {}) {
  if (!ig.accessToken || !ig.igUserId) throw new Error('Instagram não configurado (ID da conta e token).');
  const res = await axios({
    method,
    url: `${igBase(ig)}/${pathName.replace(/^\//, '')}`,
    params: { ...params, access_token: ig.accessToken },
    data,
    timeout: 20000,
  });
  return res.data;
}

const ig = {
  info: (c) => igRequest(c, 'get', c.igUserId, null, { fields: 'id,username,name,followers_count,media_count' }),
  replyComment: (c, commentId, message) => igRequest(c, 'post', `${commentId}/replies`, null, { message }),
  privateReply: (c, commentId, text) => igRequest(c, 'post', 'me/messages', { recipient: { comment_id: commentId }, message: { text } }),
  sendDm: (c, userId, text) => igRequest(c, 'post', 'me/messages', { recipient: { id: userId }, message: { text } }),
  recentMedia: (c) => igRequest(c, 'get', `${c.igUserId}/media`, null, { fields: 'id,caption,media_type,permalink,timestamp,thumbnail_url,media_url', limit: 12 }),
  createContainer: (c, body) => igRequest(c, 'post', `${c.igUserId}/media`, body),
  containerStatus: (c, id) => igRequest(c, 'get', id, null, { fields: 'status_code,status' }),
  publish: (c, creationId) => igRequest(c, 'post', `${c.igUserId}/media_publish`, { creation_id: creationId }),
};

async function waRequest(wa, method, pathName, data) {
  if (!wa.evolutionUrl || !wa.apiKey || !wa.instancia) throw new Error('WhatsApp não configurado (URL, API key e instância da Evolution API).');
  const res = await axios({
    method,
    url: `${wa.evolutionUrl}/${pathName.replace(/^\//, '')}/${encodeURIComponent(wa.instancia)}`,
    headers: { apikey: wa.apiKey },
    data,
    timeout: 20000,
  });
  return res.data;
}

function mediaTypeFromUrl(url) {
  const ext = String(url).split('?')[0].toLowerCase().split('.').pop();
  if (['mp4', 'mov', '3gp'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  return 'document';
}

const wa = {
  state: (c) => waRequest(c, 'get', 'instance/connectionState'),
  sendText: (c, number, text) => waRequest(c, 'post', 'message/sendText', { number, text }),
  sendMedia: (c, number, mediaUrl, caption) => {
    const mediatype = mediaTypeFromUrl(mediaUrl);
    const fileName = String(mediaUrl).split('?')[0].split('/').pop() || 'arquivo';
    return waRequest(c, 'post', 'message/sendMedia', { number, mediatype, media: mediaUrl, caption: caption || '', fileName });
  },
};

async function waSend(c, number, text, mediaUrl) {
  if (mediaUrl) return wa.sendMedia(c, number, mediaUrl, text);
  return wa.sendText(c, number, text);
}

// ---------------------------------------------------------------------------
// Encaminhamento (repasse do webhook bruto para o n8n ou outro sistema)
// ---------------------------------------------------------------------------

function forward(url, rawBody, headers) {
  if (!url) return;
  const pass = {};
  ['content-type', 'x-hub-signature', 'x-hub-signature-256', 'apikey'].forEach((h) => {
    if (headers[h]) pass[h] = headers[h];
  });
  pass['x-crewolada-forward'] = '1';
  axios.post(url, rawBody, { headers: pass, timeout: 15000, transformRequest: [(d) => d] })
    .catch((err) => console.error('[automacoes] falha ao encaminhar webhook:', err.message));
}

// ---------------------------------------------------------------------------
// Processamento dos eventos recebidos
// ---------------------------------------------------------------------------

// Meta and Evolution retry deliveries; the same comment/message is handled once.
const seen = new Map();
function firstTime(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.set(id, Date.now());
  if (seen.size > 5000) {
    const cut = Date.now() - 6 * 3600000;
    for (const [k, t] of seen) if (t < cut || seen.size > 4000) seen.delete(k);
  }
  return true;
}

// Reserves the rule for this contact (cooldown) in one atomic step, so two
// quick comments can't both fire before the first one is saved.
async function claimCooldown(rule, contato) {
  const minutos = Number(rule.cooldownMin || 0);
  return mutate((st) => {
    const key = `${rule.id}:${contato}`;
    const last = st.cooldown[key] ? Date.parse(st.cooldown[key]) : 0;
    if (minutos > 0 && last && Date.now() - last < minutos * 60000) return false;
    st.cooldown[key] = nowIso();
    const r = st.regras.find((x) => x.id === rule.id);
    if (r) {
      r.disparos = (r.disparos || 0) + 1;
      r.ultimoDisparo = nowIso();
    }
    // Keeps the map small: entries older than 30 days no longer block anything useful.
    const cut = Date.now() - 30 * 86400000;
    Object.keys(st.cooldown).forEach((k) => { if (Date.parse(st.cooldown[k]) < cut) delete st.cooldown[k]; });
    return true;
  });
}

async function rememberContact(canal, id, dados) {
  await mutate((st) => {
    const key = `${canal}:${id}`;
    const prev = st.contatos[key] || { canal, id, primeiroContato: nowIso(), mensagens: 0 };
    st.contatos[key] = { ...prev, ...Object.fromEntries(Object.entries(dados).filter(([, v]) => v)), ultimoContato: nowIso(), mensagens: (prev.mensagens || 0) + 1 };
  });
}

async function handleIgComment(cfg, value, regras) {
  const commentId = value.id;
  const text = value.text || '';
  const from = value.from || {};
  if (!commentId || !firstTime(`igc:${commentId}`)) return false;
  if (from.id && from.id === cfg.igUserId) return false; // our own replies
  if (value.parent_id) return false; // replies inside a thread don't trigger
  const midiaId = value.media && value.media.id;
  const rule = findRule(regras, 'ig_comentario', text, { midiaId });
  if (!rule) return false;
  const contato = from.id || from.username || commentId;
  if (!(await claimCooldown(rule, contato))) {
    await log({ canal: 'instagram', tipo: 'ignorado', regra: rule.nome, contato: from.username ? `@${from.username}` : contato, texto: text, ok: true, detalhe: 'Dentro do intervalo de espera da regra.' });
    return true;
  }
  const vars = { nome: from.username || '', primeiroNome: from.username || '', usuario: from.username ? `@${from.username}` : '' };
  const contatoLabel = from.username ? `@${from.username}` : contato;
  if (rule.respostaPublica) {
    const msg = renderText(rule.respostaPublica, vars);
    try {
      await ig.replyComment(cfg, commentId, msg);
      await log({ canal: 'instagram', tipo: 'resposta_comentario', regra: rule.nome, contato: contatoLabel, texto: text, resposta: msg, ok: true });
    } catch (err) {
      await log({ canal: 'instagram', tipo: 'resposta_comentario', regra: rule.nome, contato: contatoLabel, texto: text, resposta: msg, ok: false, erro: apiError(err) });
    }
  }
  if (rule.respostaPrivada) {
    const msg = renderText(rule.respostaPrivada, vars);
    try {
      await ig.privateReply(cfg, commentId, msg);
      await log({ canal: 'instagram', tipo: 'direct_comentario', regra: rule.nome, contato: contatoLabel, texto: text, resposta: msg, ok: true });
    } catch (err) {
      await log({ canal: 'instagram', tipo: 'direct_comentario', regra: rule.nome, contato: contatoLabel, texto: text, resposta: msg, ok: false, erro: apiError(err) });
    }
  }
  if (from.id) await rememberContact('instagram', from.id, { nome: from.username, usuario: from.username });
  return true;
}

async function handleIgMessage(cfg, ev, regras) {
  const msg = ev.message || {};
  const senderId = ev.sender && ev.sender.id;
  if (!senderId || msg.is_echo || senderId === cfg.igUserId) return false;
  if (!firstTime(`igm:${msg.mid || `${senderId}:${ev.timestamp}`}`)) return false;
  const text = msg.text || (msg.quick_reply && msg.quick_reply.payload) || '';
  await rememberContact('instagram', senderId, {});
  if (!text) return false;
  const rule = findRule(regras, 'ig_dm', text);
  if (!rule) return false;
  if (!(await claimCooldown(rule, senderId))) return true;
  const resposta = renderText(rule.respostaPrivada || rule.respostaPublica, { nome: '', primeiroNome: '', usuario: '' });
  try {
    await ig.sendDm(cfg, senderId, resposta);
    await log({ canal: 'instagram', tipo: 'resposta_direct', regra: rule.nome, contato: senderId, texto: text, resposta, ok: true });
  } catch (err) {
    await log({ canal: 'instagram', tipo: 'resposta_direct', regra: rule.nome, contato: senderId, texto: text, resposta, ok: false, erro: apiError(err) });
  }
  return true;
}

// Returns true when some rule answered (used by the "forward only when no rule answered" mode).
async function processInstagram(body) {
  const st = getState(store.load());
  const cfg = st.config.instagram;
  if (!cfg.ativo) return false;
  let respondeu = false;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'comments' || change.field === 'live_comments') {
        if (await handleIgComment(cfg, change.value || {}, st.regras)) respondeu = true;
      }
    }
    for (const ev of entry.messaging || []) {
      if (ev.message && await handleIgMessage(cfg, ev, st.regras)) respondeu = true;
    }
  }
  return respondeu;
}

function waText(message) {
  if (!message) return '';
  return message.conversation
    || (message.extendedTextMessage && message.extendedTextMessage.text)
    || (message.imageMessage && message.imageMessage.caption)
    || (message.videoMessage && message.videoMessage.caption)
    || (message.buttonsResponseMessage && message.buttonsResponseMessage.selectedDisplayText)
    || (message.listResponseMessage && message.listResponseMessage.title)
    || '';
}

async function processWhatsapp(body) {
  const event = String(body.event || '').toLowerCase().replace('_', '.');
  if (event && event !== 'messages.upsert') return false;
  const items = Array.isArray(body.data) ? body.data : [body.data || {}];
  const st = getState(store.load());
  const cfg = st.config.whatsapp;
  if (!cfg.ativo) return false;
  let respondeu = false;
  for (const data of items) {
    const key = data.key || {};
    let jid = String(key.remoteJid || '');
    // Newer WhatsApp addressing (@lid) hides the number; Evolution sends it alongside.
    if (jid.endsWith('@lid')) jid = String(key.senderPn || key.remoteJidAlt || key.participantPn || '');
    if (jid && !jid.includes('@')) jid += '@s.whatsapp.net';
    if (!jid || key.fromMe || !jid.endsWith('@s.whatsapp.net')) continue; // groups, status, own messages
    if (!firstTime(`wa:${key.id}`)) continue;
    const numero = jid.split('@')[0];
    const nome = data.pushName || '';
    const text = waText(data.message);
    await rememberContact('whatsapp', numero, { nome });
    if (!text) continue;

    const t = norm(text);
    if (cfg.optoutPalavras.map(norm).includes(t)) {
      await mutate((s) => { if (!s.optout.includes(numero)) s.optout.push(numero); });
      if (cfg.optoutResposta) {
        try { await wa.sendText(cfg, numero, cfg.optoutResposta); } catch (err) { /* logged below */ }
      }
      await log({ canal: 'whatsapp', tipo: 'descadastro', contato: numero, nome, texto: text, ok: true });
      respondeu = true;
      continue;
    }
    if (t === 'voltar' && st.optout.includes(numero)) {
      await mutate((s) => { s.optout = s.optout.filter((n) => n !== numero); });
      await log({ canal: 'whatsapp', tipo: 'recadastro', contato: numero, nome, texto: text, ok: true });
    }

    const rule = findRule(st.regras, 'wa_mensagem', text);
    if (!rule) continue;
    respondeu = true;
    if (!(await claimCooldown(rule, numero))) continue;
    const resposta = renderText(rule.respostaPrivada || rule.respostaPublica, { nome, primeiroNome: firstName(nome) });
    try {
      await waSend(cfg, numero, resposta, rule.midiaUrl);
      await log({ canal: 'whatsapp', tipo: 'resposta', regra: rule.nome, contato: numero, nome, texto: text, resposta, ok: true });
    } catch (err) {
      await log({ canal: 'whatsapp', tipo: 'resposta', regra: rule.nome, contato: numero, nome, texto: text, resposta, ok: false, erro: apiError(err) });
    }
  }
  return respondeu;
}

// ---------------------------------------------------------------------------
// Agendador: disparos de WhatsApp e publicacoes do Instagram
// ---------------------------------------------------------------------------

function horaBrasilia(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d)) % 24;
}
function diaBrasilia(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}
function dentroDaJanela(cfg, d = new Date()) {
  const h = horaBrasilia(d);
  if (cfg.janelaInicio === cfg.janelaFim) return true;
  if (cfg.janelaInicio < cfg.janelaFim) return h >= cfg.janelaInicio && h < cfg.janelaFim;
  return h >= cfg.janelaInicio || h < cfg.janelaFim;
}

let nextWakeAt = 0;
let running = false;
function wake() { nextWakeAt = 0; }

async function processDisparos(st) {
  const cfg = st.config.whatsapp;
  if (!cfg.ativo) return Infinity;
  let next = Infinity;
  const agora = Date.now();
  const hoje = diaBrasilia();
  for (const d of st.disparos) {
    if (!['agendado', 'enviando'].includes(d.status)) continue;
    const quando = Math.max(Date.parse(d.agendadoPara) || 0, Date.parse(d.proximoEnvioEm || 0) || 0);
    if (quando > agora) { next = Math.min(next, quando); continue; }
    if (!dentroDaJanela(cfg)) { next = Math.min(next, agora + 5 * 60000); continue; }
    if ((st.enviosDia[hoje] || 0) >= cfg.limiteDiario) { next = Math.min(next, agora + 30 * 60000); continue; }

    const item = (d.fila || []).find((f) => f.status === 'pendente');
    if (!item) {
      await mutate((s) => {
        const x = s.disparos.find((y) => y.id === d.id);
        if (x) { x.status = 'concluido'; x.concluidoEm = nowIso(); }
      });
      continue;
    }

    let status = 'enviado';
    let erro = '';
    if (st.optout.includes(item.numero)) {
      status = 'descadastrado';
    } else {
      let texto = renderText(d.mensagem, { nome: item.nome || '', primeiroNome: firstName(item.nome) });
      if (d.rodapeSair) texto += '\n\n_Para não receber mais, responda SAIR._';
      try {
        await waSend(cfg, item.numero, texto, d.midiaUrl);
      } catch (err) {
        status = 'falha';
        erro = apiError(err);
      }
    }
    const espera = randInt(d.intervaloMin, d.intervaloMax) * 1000;
    await mutate((s) => {
      const x = s.disparos.find((y) => y.id === d.id);
      if (!x) return;
      const f = (x.fila || []).find((y) => y.numero === item.numero && y.status === 'pendente');
      if (f) { f.status = status; f.em = nowIso(); if (erro) f.erro = erro; }
      if (x.status === 'agendado') { x.status = 'enviando'; x.iniciadoEm = nowIso(); }
      x.enviados = (x.fila || []).filter((y) => y.status === 'enviado').length;
      x.falhas = (x.fila || []).filter((y) => y.status === 'falha').length;
      x.proximoEnvioEm = new Date(Date.now() + espera).toISOString();
      if (status === 'enviado') s.enviosDia[hoje] = (s.enviosDia[hoje] || 0) + 1;
      Object.keys(s.enviosDia).forEach((k) => { if (k < diaBrasilia(new Date(Date.now() - 7 * 86400000))) delete s.enviosDia[k]; });
      if (status === 'falha') pushLog(s, { canal: 'whatsapp', tipo: 'disparo', regra: x.nome, contato: item.numero, nome: item.nome, ok: false, erro });
    });
    next = Math.min(next, Date.now() + espera);
  }
  return next;
}

async function processPosts(st) {
  const cfg = st.config.instagram;
  if (!cfg.ativo) return Infinity;
  let next = Infinity;
  const agora = Date.now();
  for (const p of st.posts) {
    if (!['agendado', 'processando'].includes(p.status)) continue;
    const quando = Date.parse(p.status === 'processando' ? p.verificarEm : p.agendadoPara) || 0;
    if (quando > agora) { next = Math.min(next, quando); continue; }
    const patch = {};
    try {
      let containerId = p.containerId;
      if (!containerId) {
        const body = { caption: p.tipo === 'story' ? undefined : p.legenda };
        if (p.tipo === 'reels') Object.assign(body, { media_type: 'REELS', video_url: p.mediaUrl });
        else if (p.tipo === 'story') Object.assign(body, { media_type: 'STORIES', [mediaTypeFromUrl(p.mediaUrl) === 'video' ? 'video_url' : 'image_url']: p.mediaUrl });
        else Object.assign(body, { image_url: p.mediaUrl });
        containerId = (await ig.createContainer(cfg, body)).id;
        patch.containerId = containerId;
      }
      const status = await ig.containerStatus(cfg, containerId).catch(() => ({ status_code: 'FINISHED' }));
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new Error(`A Meta recusou a mídia (${status.status || status.status_code}). Confira se o link é público e o formato é aceito.`);
      }
      if (status.status_code && status.status_code !== 'FINISHED' && status.status_code !== 'PUBLISHED') {
        Object.assign(patch, { status: 'processando', verificarEm: new Date(Date.now() + 30000).toISOString(), tentativas: (p.tentativas || 0) + 1 });
        if (patch.tentativas > 40) throw new Error('A Meta demorou demais para processar o vídeo.');
        next = Math.min(next, Date.now() + 30000);
      } else {
        const pub = await ig.publish(cfg, containerId);
        Object.assign(patch, { status: 'publicado', igMediaId: pub.id, publicadoEm: nowIso() });
      }
    } catch (err) {
      Object.assign(patch, { status: 'erro', erro: apiError(err) });
    }
    await mutate((s) => {
      const x = s.posts.find((y) => y.id === p.id);
      if (x) Object.assign(x, patch);
      if (patch.status === 'publicado' || patch.status === 'erro') {
        pushLog(s, { canal: 'instagram', tipo: 'publicacao', regra: p.tipo, contato: '', texto: (p.legenda || '').slice(0, 120), ok: patch.status === 'publicado', erro: patch.erro });
      }
    });
  }
  return next;
}

async function tick() {
  if (running || Date.now() < nextWakeAt) return;
  running = true;
  try {
    const st = getState(store.load());
    const a = await processDisparos(st);
    const b = await processPosts(getState(store.load()));
    const next = Math.min(a, b);
    nextWakeAt = next === Infinity ? Date.now() + 10 * 60000 : next;
  } catch (err) {
    console.error('[automacoes] erro no agendador:', err.message);
    nextWakeAt = Date.now() + 60000;
  } finally {
    running = false;
  }
}

function startAutomacoesScheduler() {
  setInterval(() => { tick(); }, TICK_MS).unref();
  setTimeout(() => { tick(); }, 3000).unref();
}

// ---------------------------------------------------------------------------
// Publico dos disparos
// ---------------------------------------------------------------------------

function parseLista(raw) {
  const out = [];
  String(raw || '').split('\n').forEach((line) => {
    const digits = onlyDigits(line);
    if (digits.length < 10) return;
    const nome = line.replace(/[+\d()\-.\s]{8,}/g, ' ').replace(/[;,|\t]+/g, ' ').trim();
    out.push({ numero: normalizePhone(digits), nome });
  });
  return out;
}

function montarPublico(db, st, { origem, evento, lista }) {
  const map = new Map();
  const add = (numero, nome) => {
    const n = onlyDigits(numero);
    if (n.length < 12 || map.has(n)) return;
    map.set(n, { numero: n, nome: clean(nome, 80) });
  };
  if (origem === 'lista') parseLista(lista).forEach((c) => add(c.numero, c.nome));
  if (origem === 'compradores' || origem === 'todos') {
    Object.values(db.orders || {}).forEach((o) => {
      if (o.status !== 'paid' || o.loteName === 'Lote Teste' || !o.buyerPhone) return;
      if (evento && evento !== 'todos' && orderEventId(o) !== evento) return;
      add(normalizePhone(o.buyerPhone), o.buyerName);
    });
  }
  if (origem === 'contatos' || origem === 'todos') {
    Object.values(st.contatos).forEach((c) => { if (c.canal === 'whatsapp') add(c.id, c.nome); });
  }
  return [...map.values()].filter((c) => !st.optout.includes(c.numero));
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

function registerAutomacoesRoutes(app, { requireAdminAuth, eventInfo, parseDatetimeLocalAsBrasilia, formatDatetimeBrasiliaDisplay }) {
  const baseUrl = () => (process.env.BASE_URL || 'https://crewolada.com').replace(/\/$/, '');
  const fmt = (iso) => (iso ? formatDatetimeBrasiliaDisplay(iso) : '');
  const back = (res, aba, msg, extra = '') => res.redirect(`/admin/automacoes?aba=${aba}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}${extra}`);

  // Generates the secrets the webhooks need the first time the page is opened.
  async function ensureTokens() {
    const st = getState(store.load());
    if (st.config.instagram.verifyToken && st.config.whatsapp.webhookToken) return;
    await mutate((s, db) => {
      const raw = rawConfig(db);
      if (!s.config.instagram.verifyToken) raw.instagram.verifyToken = crypto.randomBytes(16).toString('hex');
      if (!s.config.whatsapp.webhookToken) raw.whatsapp.webhookToken = crypto.randomBytes(16).toString('hex');
    });
  }

  app.get('/admin/automacoes', requireAdminAuth, async (req, res) => {
    await ensureTokens();
    const db = store.load();
    const st = getState(db);
    const aba = ['inicio', 'regras', 'disparos', 'publicacoes', 'contatos', 'historico', 'config'].includes(req.query.aba) ? req.query.aba : 'inicio';
    const dia = Date.now() - 86400000;
    const log24 = st.log.filter((l) => Date.parse(l.ts) >= dia);
    const contatosLista = Object.values(st.contatos).sort((a, b) => String(b.ultimoContato).localeCompare(String(a.ultimoContato)));
    const editar = st.regras.find((r) => r.id === req.query.editar) || null;
    res.render('admin_automacoes', {
      eventInfo,
      aba,
      msg: req.query.msg || null,
      erro: req.query.erro || null,
      st,
      igCfg: { ...st.config.instagram, accessTokenMask: mask(st.config.instagram.accessToken), appSecretMask: mask(st.config.instagram.appSecret) },
      waCfg: { ...st.config.whatsapp, apiKeyMask: mask(st.config.whatsapp.apiKey) },
      webhooks: {
        instagram: `${baseUrl()}/api/webhooks/instagram`,
        whatsapp: `${baseUrl()}/api/webhooks/whatsapp?token=${st.config.whatsapp.webhookToken}`,
      },
      kpis: {
        regrasAtivas: st.regras.filter((r) => r.ativo).length,
        respostas24: log24.filter((l) => l.ok && ['resposta', 'resposta_direct', 'resposta_comentario', 'direct_comentario'].includes(l.tipo)).length,
        erros24: log24.filter((l) => !l.ok).length,
        disparosAtivos: st.disparos.filter((d) => ['agendado', 'enviando', 'pausado'].includes(d.status)).length,
        enviadosHoje: st.enviosDia[diaBrasilia()] || 0,
        contatosWa: contatosLista.filter((c) => c.canal === 'whatsapp').length,
        contatosIg: contatosLista.filter((c) => c.canal === 'instagram').length,
        postsAgendados: st.posts.filter((p) => ['agendado', 'processando'].includes(p.status)).length,
      },
      editar,
      contatosLista: contatosLista.slice(0, 300),
      eventos: EVENTS.filter((e) => !e.hidden).map((e) => ({ id: e.id, name: e.name, dateLabel: e.dateLabel })),
      currentEventId: currentEvent.id,
      GATILHOS,
      MODOS,
      fmt,
      simulacao: req.query.sim ? (() => {
        const g = GATILHOS[req.query.simGatilho] ? req.query.simGatilho : 'wa_mensagem';
        const r = findRule(st.regras, g, String(req.query.sim));
        return { texto: String(req.query.sim), gatilho: g, regra: r, resposta: r ? renderText(r.respostaPrivada || r.respostaPublica, { nome: 'Maria Silva', primeiroNome: 'Maria', usuario: '@maria' }) : '', publica: r && r.respostaPublica && g === 'ig_comentario' ? renderText(r.respostaPublica, { nome: 'maria', usuario: '@maria' }) : '' };
      })() : null,
    });
  });

  // ---- configuracao ----
  app.post('/admin/automacoes/config/instagram', requireAdminAuth, async (req, res) => {
    const b = req.body;
    await mutate((st, db) => {
      const raw = rawConfig(db);
      const cur = raw.instagram;
      const next = {
        ...cur,
        ativo: b.ativo === 'on',
        igUserId: clean(b.igUserId, 40).replace(/\D/g, ''),
        apiHost: b.apiHost === 'graph.facebook.com' ? 'graph.facebook.com' : 'graph.instagram.com',
        apiVersion: /^v\d+\.\d+$/.test(clean(b.apiVersion, 10)) ? clean(b.apiVersion, 10) : 'v23.0',
        verifyToken: clean(b.verifyToken, 80) || cur.verifyToken,
        encaminharUrl: /^https?:\/\//.test(clean(b.encaminharUrl, 300)) ? clean(b.encaminharUrl, 300) : '',
        encaminharModo: b.encaminharModo === 'sem_regra' ? 'sem_regra' : 'sempre',
      };
      if (clean(b.accessToken, 600)) next.accessToken = clean(b.accessToken, 600);
      if (clean(b.appSecret, 200)) next.appSecret = clean(b.appSecret, 200);
      raw.instagram = next;
    });
    wake();
    back(res, 'config', 'Instagram salvo.');
  });

  app.post('/admin/automacoes/config/whatsapp', requireAdminAuth, async (req, res) => {
    const b = req.body;
    const hora = (v, d) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= 0 && n <= 24 ? n % 24 : d; };
    await mutate((st, db) => {
      const raw = rawConfig(db);
      const cur = raw.whatsapp;
      const next = {
        ...cur,
        ativo: b.ativo === 'on',
        evolutionUrl: /^https?:\/\//.test(clean(b.evolutionUrl, 300)) ? clean(b.evolutionUrl, 300).replace(/\/$/, '') : '',
        instancia: clean(b.instancia, 80),
        encaminharUrl: /^https?:\/\//.test(clean(b.encaminharUrl, 300)) ? clean(b.encaminharUrl, 300) : '',
        encaminharModo: b.encaminharModo === 'sem_regra' ? 'sem_regra' : 'sempre',
        optoutPalavras: parsePalavras(b.optoutPalavras),
        optoutResposta: clean(b.optoutResposta, 500),
        janelaInicio: hora(b.janelaInicio, 9),
        janelaFim: hora(b.janelaFim, 21),
        limiteDiario: Math.max(1, Math.min(5000, parseInt(b.limiteDiario, 10) || 200)),
      };
      if (clean(b.apiKey, 300)) next.apiKey = clean(b.apiKey, 300);
      if (b.novoToken === 'on') next.webhookToken = crypto.randomBytes(16).toString('hex');
      raw.whatsapp = next;
    });
    wake();
    back(res, 'config', 'WhatsApp salvo.');
  });

  app.post('/admin/automacoes/testar/:canal', requireAdminAuth, async (req, res) => {
    const st = getState(store.load());
    try {
      if (req.params.canal === 'instagram') {
        const info = await ig.info(st.config.instagram);
        return back(res, 'config', `Instagram conectado: @${info.username || info.name || info.id}${info.followers_count != null ? ` (${info.followers_count} seguidores)` : ''}.`);
      }
      const r = await wa.state(st.config.whatsapp);
      const state = (r.instance && r.instance.state) || r.state || JSON.stringify(r).slice(0, 80);
      if (req.body.numero) {
        const numero = normalizePhone(req.body.numero);
        await wa.sendText(st.config.whatsapp, numero, clean(req.body.texto, 500) || 'Teste das automações da Crewolada ✅');
        return back(res, 'config', `WhatsApp: instância ${state}. Mensagem de teste enviada para ${numero}.`);
      }
      return back(res, 'config', `WhatsApp: instância ${state}${state === 'open' ? ' (conectada)' : ' — escaneie o QR Code na Evolution API'}.`);
    } catch (err) {
      return res.redirect(`/admin/automacoes?aba=config&erro=${encodeURIComponent(`Falha no teste: ${apiError(err)}`)}`);
    }
  });

  app.get('/admin/automacoes/instagram/posts', requireAdminAuth, async (req, res) => {
    try {
      const r = await ig.recentMedia(getState(store.load()).config.instagram);
      res.json({ ok: true, posts: (r.data || []).map((m) => ({ id: m.id, caption: (m.caption || '').slice(0, 80), permalink: m.permalink, thumb: m.thumbnail_url || m.media_url, timestamp: m.timestamp })) });
    } catch (err) {
      res.status(400).json({ ok: false, error: apiError(err) });
    }
  });

  // ---- regras ----
  app.post('/admin/automacoes/regras', requireAdminAuth, async (req, res) => {
    const b = req.body;
    const gatilho = GATILHOS[b.gatilho] ? b.gatilho : 'wa_mensagem';
    const modo = MODOS[b.modo] ? b.modo : 'contem';
    const regra = {
      nome: clean(b.nome, 80) || 'Regra sem nome',
      gatilho,
      canal: GATILHOS[gatilho].canal,
      modo,
      palavras: parsePalavras(b.palavras),
      midiaId: gatilho === 'ig_comentario' ? clean(b.midiaId, 40).replace(/\D/g, '') : '',
      respostaPublica: gatilho === 'ig_comentario' ? clean(b.respostaPublica) : '',
      respostaPrivada: clean(b.respostaPrivada),
      midiaUrl: gatilho === 'wa_mensagem' && /^https?:\/\//.test(clean(b.midiaUrl, 500)) ? clean(b.midiaUrl, 500) : '',
      cooldownMin: Math.max(0, Math.min(43200, parseInt(b.cooldownMin, 10) || 0)),
      ativo: b.ativo === 'on',
    };
    if (modo !== 'qualquer' && !regra.palavras.length) return res.redirect(`/admin/automacoes?aba=regras&erro=${encodeURIComponent('Informe ao menos uma palavra-chave (ou escolha "Qualquer mensagem").')}`);
    if (!regra.respostaPrivada && !regra.respostaPublica) return res.redirect(`/admin/automacoes?aba=regras&erro=${encodeURIComponent('Escreva a resposta da regra.')}`);
    const id = clean(b.id, 40);
    await mutate((st) => {
      const i = st.regras.findIndex((r) => r.id === id);
      if (id && i !== -1) st.regras[i] = { ...st.regras[i], ...regra, atualizadoEm: nowIso() };
      else st.regras.push({ id: crypto.randomUUID(), ...regra, disparos: 0, criadoEm: nowIso() });
    });
    back(res, 'regras', id ? 'Regra atualizada.' : 'Regra criada.');
  });

  app.post('/admin/automacoes/regras/:id/:acao', requireAdminAuth, async (req, res) => {
    const { id, acao } = req.params;
    await mutate((st) => {
      const i = st.regras.findIndex((r) => r.id === id);
      if (i === -1) return;
      if (acao === 'alternar') st.regras[i].ativo = !st.regras[i].ativo;
      else if (acao === 'excluir') st.regras.splice(i, 1);
      else if (acao === 'subir' && i > 0) [st.regras[i - 1], st.regras[i]] = [st.regras[i], st.regras[i - 1]];
      else if (acao === 'descer' && i < st.regras.length - 1) [st.regras[i + 1], st.regras[i]] = [st.regras[i], st.regras[i + 1]];
      else if (acao === 'duplicar') st.regras.splice(i + 1, 0, { ...st.regras[i], id: crypto.randomUUID(), nome: `${st.regras[i].nome} (cópia)`, ativo: false, disparos: 0, criadoEm: nowIso() });
    });
    back(res, 'regras', acao === 'excluir' ? 'Regra excluída.' : '');
  });

  // ---- disparos de WhatsApp ----
  app.post('/admin/automacoes/disparos/previa', requireAdminAuth, (req, res) => {
    const db = store.load();
    const st = getState(db);
    const publico = montarPublico(db, st, { origem: req.body.origem, evento: req.body.evento, lista: req.body.lista });
    res.json({ total: publico.length, exemplo: publico.slice(0, 5).map((c) => `${c.nome || 'Sem nome'} · +${c.numero}`) });
  });

  app.post('/admin/automacoes/disparos', requireAdminAuth, async (req, res) => {
    const b = req.body;
    const mensagem = clean(b.mensagem, 4000);
    if (!mensagem) return res.redirect(`/admin/automacoes?aba=disparos&erro=${encodeURIComponent('Escreva a mensagem do disparo.')}`);
    const origem = ['lista', 'compradores', 'contatos', 'todos'].includes(b.origem) ? b.origem : 'lista';
    const intervaloMin = Math.max(10, Math.min(3600, parseInt(b.intervaloMin, 10) || 25));
    const intervaloMax = Math.max(intervaloMin, Math.min(3600, parseInt(b.intervaloMax, 10) || 60));
    const agendadoPara = b.agendadoPara ? parseDatetimeLocalAsBrasilia(b.agendadoPara) : nowIso();
    const result = await mutate((st, db) => {
      const fila = montarPublico(db, st, { origem, evento: b.evento, lista: b.lista }).map((c) => ({ ...c, status: 'pendente' }));
      if (!fila.length) return { erro: 'Nenhum contato com WhatsApp válido nesse público.' };
      st.disparos.unshift({
        id: crypto.randomUUID(),
        nome: clean(b.nome, 80) || `Disparo ${new Date().toLocaleDateString('pt-BR', { timeZone: TZ })}`,
        mensagem,
        midiaUrl: /^https?:\/\//.test(clean(b.midiaUrl, 500)) ? clean(b.midiaUrl, 500) : '',
        origem,
        evento: origem === 'compradores' || origem === 'todos' ? clean(b.evento, 60) : '',
        rodapeSair: b.rodapeSair === 'on',
        intervaloMin,
        intervaloMax,
        agendadoPara,
        status: 'agendado',
        total: fila.length,
        enviados: 0,
        falhas: 0,
        fila,
        criadoEm: nowIso(),
      });
      if (st.disparos.length > 100) st.disparos.length = 100;
      return { total: fila.length };
    });
    if (result.erro) return res.redirect(`/admin/automacoes?aba=disparos&erro=${encodeURIComponent(result.erro)}`);
    wake();
    back(res, 'disparos', `Disparo agendado para ${result.total} contatos.`);
  });

  app.post('/admin/automacoes/disparos/:id/:acao', requireAdminAuth, async (req, res) => {
    const { id, acao } = req.params;
    await mutate((st) => {
      const i = st.disparos.findIndex((d) => d.id === id);
      if (i === -1) return;
      const d = st.disparos[i];
      if (acao === 'pausar' && ['agendado', 'enviando'].includes(d.status)) { d.statusAntes = d.status; d.status = 'pausado'; }
      else if (acao === 'retomar' && d.status === 'pausado') { d.status = d.statusAntes || 'agendado'; d.proximoEnvioEm = nowIso(); }
      else if (acao === 'cancelar' && !['concluido', 'cancelado'].includes(d.status)) { d.status = 'cancelado'; d.canceladoEm = nowIso(); }
      else if (acao === 'reenviar_falhas') {
        (d.fila || []).forEach((f) => { if (f.status === 'falha') { f.status = 'pendente'; delete f.erro; } });
        d.status = 'enviando';
        d.proximoEnvioEm = nowIso();
      } else if (acao === 'excluir' && !['enviando'].includes(d.status)) st.disparos.splice(i, 1);
    });
    wake();
    back(res, 'disparos', '');
  });

  // ---- publicacoes agendadas no Instagram ----
  app.post('/admin/automacoes/posts', requireAdminAuth, async (req, res) => {
    const b = req.body;
    const mediaUrl = clean(b.mediaUrl, 1000);
    if (!/^https:\/\//.test(mediaUrl)) return res.redirect(`/admin/automacoes?aba=publicacoes&erro=${encodeURIComponent('Informe o link público (https) da imagem ou do vídeo.')}`);
    const tipo = ['imagem', 'reels', 'story'].includes(b.tipo) ? b.tipo : 'imagem';
    await mutate((st) => {
      st.posts.unshift({
        id: crypto.randomUUID(),
        tipo,
        mediaUrl,
        legenda: clean(b.legenda, 2200),
        agendadoPara: b.agendadoPara ? parseDatetimeLocalAsBrasilia(b.agendadoPara) : nowIso(),
        status: 'agendado',
        criadoEm: nowIso(),
      });
      if (st.posts.length > 200) st.posts.length = 200;
    });
    wake();
    back(res, 'publicacoes', 'Publicação agendada.');
  });

  app.post('/admin/automacoes/posts/:id/:acao', requireAdminAuth, async (req, res) => {
    const { id, acao } = req.params;
    await mutate((st) => {
      const i = st.posts.findIndex((p) => p.id === id);
      if (i === -1) return;
      if (acao === 'excluir' && st.posts[i].status !== 'processando') st.posts.splice(i, 1);
      if (acao === 'tentar' && st.posts[i].status === 'erro') Object.assign(st.posts[i], { status: 'agendado', erro: '', containerId: '', tentativas: 0, agendadoPara: nowIso() });
    });
    wake();
    back(res, 'publicacoes', '');
  });

  // ---- contatos, descadastros e historico ----
  app.post('/admin/automacoes/optout', requireAdminAuth, async (req, res) => {
    const numero = onlyDigits(req.body.numero);
    if (numero.length >= 10) {
      const n = normalizePhone(numero);
      await mutate((st) => {
        if (req.body.acao === 'remover') st.optout = st.optout.filter((x) => x !== n);
        else if (!st.optout.includes(n)) st.optout.push(n);
      });
    }
    back(res, 'contatos', '');
  });

  app.get('/admin/automacoes/contatos.csv', requireAdminAuth, (req, res) => {
    const st = getState(store.load());
    const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [['Canal', 'ID/Número', 'Nome', 'Primeiro contato', 'Último contato', 'Mensagens', 'Descadastrado'].join(';')];
    Object.values(st.contatos).forEach((c) => rows.push([c.canal, c.id, c.nome || c.usuario || '', fmt(c.primeiroContato), fmt(c.ultimoContato), c.mensagens || 0, st.optout.includes(c.id) ? 'sim' : ''].map(cell).join(';')));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="contatos-automacoes.csv"');
    res.send(`﻿${rows.join('\n')}`);
  });

  app.post('/admin/automacoes/historico/limpar', requireAdminAuth, async (req, res) => {
    await mutate((st) => { st.log = []; });
    back(res, 'historico', 'Histórico limpo.');
  });

  // ---- webhooks publicos ----
  // Meta: verificacao do webhook (Assinatura > Verificar e salvar).
  app.get('/api/webhooks/instagram', (req, res) => {
    const st = getState(store.load());
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] && req.query['hub.verify_token'] === st.config.instagram.verifyToken) {
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    return res.sendStatus(403);
  });

  app.post('/api/webhooks/instagram', (req, res) => {
    const st = getState(store.load());
    const cfg = st.config.instagram;
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (cfg.appSecret) {
      const sig = String(req.headers['x-hub-signature-256'] || '');
      const expected = `sha256=${crypto.createHmac('sha256', cfg.appSecret).update(raw).digest('hex')}`;
      const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) return res.sendStatus(401);
    }
    res.sendStatus(200); // Meta expects a fast answer; work continues after it.
    processInstagram(req.body || {})
      .then((respondeu) => { if (cfg.encaminharUrl && (cfg.encaminharModo === 'sempre' || !respondeu)) forward(cfg.encaminharUrl, raw, req.headers); })
      .catch((err) => console.error('[automacoes] erro no webhook do Instagram:', err.message));
  });

  app.post('/api/webhooks/whatsapp', (req, res) => {
    const st = getState(store.load());
    const cfg = st.config.whatsapp;
    const token = String(req.query.token || req.headers['x-webhook-token'] || '');
    if (!cfg.webhookToken || token.length !== cfg.webhookToken.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cfg.webhookToken))) return res.sendStatus(401);
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    res.sendStatus(200);
    processWhatsapp(req.body || {})
      .then((respondeu) => { if (cfg.encaminharUrl && (cfg.encaminharModo === 'sempre' || !respondeu)) forward(cfg.encaminharUrl, raw, req.headers); })
      .catch((err) => console.error('[automacoes] erro no webhook do WhatsApp:', err.message));
  });
}

module.exports = {
  registerAutomacoesRoutes,
  startAutomacoesScheduler,
  // exported for tests
  _internals: { matchesRule, findRule, parseLista, renderText, dentroDaJanela, norm },
};
