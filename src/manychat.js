const crypto = require('crypto');
const store = require('./store');
const { currentEvent, salesHeldBack, salesOpensAt, showLeft } = require('./event');

// "ManyChat" of the @festacrewolada Instagram (crewolada.com/manychat), built on
// the same structure as the Metodo Seta automation (@consorcioparaleigos): the
// site keeps the rules and the n8n workflow talks to the Instagram Graph API.
//
//   Instagram (comment / Direct / story reply)
//     -> n8n "Crewolada - ManyChat Instagram" (Meta webhook)
//     -> POST /api/n8n/manychat  (this file: finds the rule, fills in the party info)
//     <- ready-made Graph API bodies: public reply to the comment + Direct message
//     -> n8n posts them to graph.instagram.com. No match in the Direct: n8n hands the
//        message to the AI agent (/bot) as before.
//
// Keywords are matched without accents/case. In comments and story replies a rule
// fires when the text CONTAINS a keyword (or on any comment, mode "qualquer"); in the
// Direct only when the whole message IS the keyword ("INGRESSO"), so normal
// conversations keep going to the AI agent.

const MAX_REGRAS = 60;
const MAX_LOG = 300;
const MAX_VISTOS = 2000;
const COOLDOWN_MS = 10 * 60 * 1000; // same person + same rule in the Direct/story
const MAX_BOTOES = 3; // Instagram button template limit

const clean = (v, max) => String(v || '').replace(/\r/g, '').trim().slice(0, max);
const brl = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9@#\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const CANAIS = ['comentario', 'dm', 'story'];
const CANAL_LABEL = { comentario: 'Comentário em post/reels', dm: 'Direct', story: 'Resposta a story' };

// Ready on the first run: the most common questions about the party.
const REGRAS_PADRAO = [
  {
    nome: 'Ingressos (link de compra)',
    canais: ['comentario', 'dm', 'story'],
    modo: 'contem',
    palavras: ['ingresso', 'ingressos', 'eu quero', 'quero', 'link', 'comprar', 'valor', 'preco', 'quanto', 'lote', 'eu vou'],
    respostasComentario: [
      'Te mandei o link no Direct, {nome}! 🔥',
      'Corre no Direct que o link tá lá! 🎟️',
      'Enviado no seu Direct ✨ Te vejo na festa!',
    ],
    mensagem: 'Oi {nome}! 🎉 Aqui está tudo sobre a {evento}:\n\n📅 {data}{hora_txt}\n📍 {local}\n🎟️ {preco}\n\n{situacao}',
    botoes: [{ titulo: 'Comprar ingresso', url: '{link}' }, { titulo: 'Comunidade WhatsApp', url: '{comunidade}' }],
  },
  {
    nome: 'Data e local',
    canais: ['comentario', 'dm', 'story'],
    modo: 'contem',
    palavras: ['onde', 'local', 'endereco', 'quando', 'data', 'que dia', 'horario', 'que horas', 'mapa'],
    respostasComentario: ['Te mandei data e local no Direct! 📍', 'Olha o Direct, {nome}! Tá tudo lá 📅'],
    mensagem: 'Oi {nome}! A {evento} vai ser:\n\n📅 {data}{hora_txt}\n📍 {local}\n\n{situacao}',
    botoes: [{ titulo: 'Ver no mapa', url: '{mapa}' }, { titulo: 'Ingressos', url: '{link}' }],
  },
  {
    nome: 'Comunidade / lista de novidades',
    canais: ['comentario', 'dm', 'story'],
    modo: 'contem',
    palavras: ['lista', 'comunidade', 'grupo', 'whatsapp', 'zap', 'novidades', 'me avisa', 'avisa'],
    respostasComentario: ['Te mandei o link da comunidade no Direct! 💬'],
    mensagem: 'Oi {nome}! Entra na comunidade da Crewolada no WhatsApp: as novidades, lotes e próximas festas saem lá primeiro 👇',
    botoes: [{ titulo: 'Entrar na comunidade', url: '{comunidade}' }],
  },
  {
    nome: 'Meu ingresso (não recebi)',
    canais: ['comentario', 'dm'],
    modo: 'contem',
    palavras: ['meu ingresso', 'nao recebi', 'nao chegou', 'reenviar', 'qr code', 'qrcode'],
    respostasComentario: ['{nome}, te chamei no Direct pra resolver! 🙌'],
    mensagem: 'Oi {nome}! O ingresso chega no e-mail da compra (olha também o spam e promoções). Você também consegue ver e baixar seus ingressos a qualquer momento no link abaixo, ou pedir pelo nosso WhatsApp {whatsapp_label}.',
    botoes: [{ titulo: 'Meus ingressos', url: '{site}/meus-ingressos' }, { titulo: 'Falar no WhatsApp', url: '{whatsapp}' }],
  },
  {
    nome: 'Contratar a Crewolada',
    canais: ['comentario', 'dm'],
    modo: 'contem',
    palavras: ['contratar', 'orcamento', 'festa particular', 'aniversario', 'casamento', 'evento fechado', 'contrato'],
    respostasComentario: ['Te mandei os detalhes no Direct! 🎧'],
    mensagem: 'Oi {nome}! Quer levar a Crewolada para o seu evento (DJ ou festa completa)? Manda os detalhes pelo link abaixo que a equipe te responde 💜',
    botoes: [{ titulo: 'Pedir orçamento', url: '{site}/contato' }],
  },
];

function novaRegra(r) {
  return {
    id: crypto.randomUUID(),
    ativo: true,
    nome: '',
    canais: ['comentario'],
    modo: 'contem',
    palavras: [],
    posts: [],
    respostasComentario: [],
    mensagem: '',
    botoes: [],
    disparos: 0,
    ultimoDisparo: null,
    criadoEm: new Date().toISOString(),
    ...r,
  };
}

function getMC(db) {
  const m = db.manychat || {};
  return {
    ativo: m.ativo !== false,
    // false = fill the reply only (n8n may still answer the comment publicly)
    responderComentario: m.responderComentario !== false,
    regras: Array.isArray(m.regras) ? m.regras : REGRAS_PADRAO.map(novaRegra),
    log: Array.isArray(m.log) ? m.log : [],
    vistos: m.vistos && typeof m.vistos === 'object' ? m.vistos : {},
  };
}

// ---------------------------------------------------------------- variables

function variaveis(deps, pessoa = {}) {
  const ev = currentEvent;
  const site = deps.baseUrl;
  const link = ev.paths && ev.paths[0] ? `${site}/${ev.paths[0]}` : `${site}/ingressos`;
  const info = deps.infoVenda(); // { preco, restantes, esgotado }
  let situacao;
  if (ev.cancelledAt) {
    situacao = `⚠️ Esse evento foi cancelado. Motivo: ${(String(ev.cancelReason || 'não informado').replace(/[.\s]+$/, ''))}. Quem comprou recebe o reembolso integral em até 7 dias corridos.`;
  } else if (salesHeldBack(ev)) {
    situacao = `⏳ As vendas abrem ${deps.opensLabel(salesOpensAt(ev))}. Entra na comunidade pra ser avisado!`;
  } else if (!deps.salesOpenNow() || info.esgotado) {
    situacao = info.esgotado ? '🚫 Ingressos esgotados! Entra na comunidade pra saber das próximas.' : 'As vendas estão encerradas no momento.';
  } else {
    situacao = `✅ Vendas abertas! Pix ou cartão${showLeft(info.restantes, ev) ? ` · restam só ${info.restantes} ingressos` : ''}.`;
  }
  const primeiro = clean(pessoa.nome, 60).split(/\s+/)[0] || (pessoa.usuario ? '@' + clean(pessoa.usuario, 60).replace(/^@/, '') : '');
  return {
    nome: primeiro || 'tudo bem',
    usuario: pessoa.usuario ? '@' + clean(pessoa.usuario, 60).replace(/^@/, '') : '',
    evento: ev.name || 'Crewolada',
    data: ev.dateLabel || '',
    hora: ev.timeLabel || '',
    hora_txt: ev.timeLabel ? ` às ${ev.timeLabel}` : '',
    local: ev.venue || '',
    mapa: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.venue || 'Crewolada')}`,
    preco: info.preco || 'valores no link',
    restantes: info.restantes != null ? String(info.restantes) : '',
    situacao,
    link,
    site,
    comunidade: deps.communityUrl,
    whatsapp: deps.whatsappTicketUrl,
    whatsapp_label: deps.whatsappLabel,
  };
}

const preencher = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// ---------------------------------------------------------------- matching

const shortcode = (s) => {
  const m = String(s || '').match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
};

function postConfere(regra, msg) {
  if (!regra.posts || !regra.posts.length) return true;
  const alvo = [String(msg.media_id || ''), shortcode(msg.permalink) || ''].filter(Boolean);
  return regra.posts.some((p) => {
    const sc = shortcode(p);
    return alvo.includes(sc || String(p).trim());
  });
}

function palavraConfere(regra, canal, texto) {
  const t = norm(texto);
  if (canal === 'dm') return regra.palavras.some((p) => norm(p) && t === norm(p));
  if (regra.modo === 'qualquer') return true;
  if (!t) return false;
  const padded = ` ${t} `;
  return regra.palavras.some((p) => {
    const k = norm(p);
    if (!k) return false;
    return regra.modo === 'exata' ? t === k : padded.includes(` ${k} `);
  });
}

// Rules tied to specific posts win over the general ones; otherwise the panel order.
function encontrarRegra(regras, canal, msg) {
  const ativas = regras.filter((r) => r.ativo && r.canais.includes(canal));
  const ordenadas = [...ativas.filter((r) => r.posts.length), ...ativas.filter((r) => !r.posts.length)];
  return ordenadas.find((r) => postConfere(r, msg) && palavraConfere(r, canal, msg.texto)) || null;
}

function montarResposta(regra, canal, msg, deps, mc) {
  const vars = variaveis(deps, msg);
  const texto = preencher(regra.mensagem, vars).slice(0, 640);
  const botoes = (regra.botoes || [])
    .map((b) => ({ titulo: preencher(b.titulo, vars).slice(0, 20), url: preencher(b.url, vars) }))
    .filter((b) => b.titulo && /^https?:\/\//.test(b.url))
    .slice(0, MAX_BOTOES);
  const variantes = (regra.respostasComentario || []).filter(Boolean);
  const comentario = canal === 'comentario' && mc.responderComentario && variantes.length
    ? preencher(variantes[Math.floor(Math.random() * variantes.length)], vars).slice(0, 300)
    : null;

  // Graph API bodies ready for n8n (POST graph.instagram.com/vXX/me/messages).
  // A comment is answered with a "private reply" (recipient.comment_id).
  const recipient = canal === 'comentario' && msg.comment_id ? { comment_id: String(msg.comment_id) } : { id: String(msg.sender_id || '') };
  const message = texto
    ? (botoes.length
      ? { attachment: { type: 'template', payload: { template_type: 'button', text: texto, buttons: botoes.map((b) => ({ type: 'web_url', url: b.url, title: b.titulo })) } } }
      : { text: texto })
    : null;
  return {
    comentario,
    dm: texto ? { texto, botoes } : null,
    graph: {
      responderComentario: comentario && msg.comment_id ? { path: `/${msg.comment_id}/replies`, body: { message: comentario } } : null,
      enviarDm: message ? { path: '/me/messages', body: { recipient, message } } : null,
    },
  };
}

// Simulation for the panel: no counters, no log, no dedup.
function simular(db, deps, canal, texto, extras = {}) {
  const mc = getMC(db);
  const msg = { texto, nome: 'Maria Teste', usuario: 'maria.teste', comment_id: '1789', sender_id: '1234', ...extras };
  const regra = encontrarRegra(mc.regras, canal, msg);
  if (!regra) return { match: false };
  return { match: true, regra: { id: regra.id, nome: regra.nome }, ...montarResposta(regra, canal, msg, deps, mc) };
}

// ---------------------------------------------------------------- routes

function lerRegra(body) {
  const lista = (v, max) => String(v || '').split(/[\n,]+/).map((s) => clean(s, max)).filter(Boolean);
  const canais = CANAIS.filter((c) => body['canal_' + c] === 'on');
  const botoes = [];
  for (let i = 0; i < MAX_BOTOES; i++) {
    const titulo = clean(body['botao_titulo_' + i], 20);
    const url = clean(body['botao_url_' + i], 500);
    if (titulo && url) botoes.push({ titulo, url });
  }
  return {
    nome: clean(body.nome, 80),
    ativo: body.ativo === 'on',
    canais: canais.length ? canais : ['comentario'],
    modo: ['contem', 'exata', 'qualquer'].includes(body.modo) ? body.modo : 'contem',
    palavras: lista(body.palavras, 60).slice(0, 40),
    posts: lista(body.posts, 200).slice(0, 30),
    respostasComentario: String(body.respostasComentario || '').split('\n').map((s) => clean(s, 300)).filter(Boolean).slice(0, 10),
    mensagem: clean(body.mensagem, 1000),
    botoes,
  };
}

function registerManychatRoutes(app, { requireAdminAuth, eventInfo, deps }) {
  const baseUrl = () => (process.env.BASE_URL || 'https://crewolada.com').replace(/\/$/, '');
  const fullDeps = () => ({ ...deps, baseUrl: baseUrl() });
  const salvar = (fn) => store.withDb((db) => { const mc = getMC(db); fn(mc); db.manychat = mc; });

  app.get('/manychat', requireAdminAuth, async (req, res) => {
    // First visit: store the default rules so their ids stay stable.
    if (!store.load().manychat) await salvar(() => {});
    const db = store.load();
    const mc = getMC(db);
    res.render('admin_manychat', {
      eventInfo, mc, canais: CANAIS, canalLabel: CANAL_LABEL, maxBotoes: MAX_BOTOES,
      vars: variaveis(fullDeps(), { nome: 'Maria' }),
      endpoint: `${baseUrl()}/api/n8n/manychat`,
      secretConfigurado: Boolean(process.env.N8N_CALLBACK_SECRET),
      msg: req.query.msg || null,
      editar: req.query.editar || null,
    });
  });

  app.post('/manychat/geral', requireAdminAuth, async (req, res) => {
    await salvar((mc) => { mc.ativo = req.body.ativo === 'on'; mc.responderComentario = req.body.responderComentario === 'on'; });
    res.redirect('/manychat?msg=salvo');
  });

  app.post('/manychat/regras', requireAdminAuth, async (req, res) => {
    const dados = lerRegra(req.body);
    if (!dados.nome || !dados.mensagem || (dados.modo !== 'qualquer' && !dados.palavras.length)) {
      return res.redirect('/manychat?msg=regra_incompleta#regras');
    }
    const id = clean(req.body.id, 40);
    let erro = null;
    await salvar((mc) => {
      const i = mc.regras.findIndex((r) => r.id === id);
      if (id && i !== -1) mc.regras[i] = { ...mc.regras[i], ...dados, atualizadoEm: new Date().toISOString() };
      else if (mc.regras.length >= MAX_REGRAS) erro = 'limite';
      else mc.regras.push(novaRegra(dados));
    });
    res.redirect(erro ? '/manychat?msg=limite#regras' : '/manychat?msg=salvo#regras');
  });

  app.post('/manychat/regras/:id/:acao', requireAdminAuth, async (req, res) => {
    const { id, acao } = req.params;
    await salvar((mc) => {
      const i = mc.regras.findIndex((r) => r.id === id);
      if (i === -1) return;
      if (acao === 'excluir') mc.regras.splice(i, 1);
      else if (acao === 'alternar') mc.regras[i].ativo = !mc.regras[i].ativo;
      else if (acao === 'subir' && i > 0) [mc.regras[i - 1], mc.regras[i]] = [mc.regras[i], mc.regras[i - 1]];
      else if (acao === 'descer' && i < mc.regras.length - 1) [mc.regras[i + 1], mc.regras[i]] = [mc.regras[i], mc.regras[i + 1]];
      else if (acao === 'zerar') { mc.regras[i].disparos = 0; mc.regras[i].ultimoDisparo = null; }
    });
    res.redirect('/manychat?msg=salvo#regras');
  });

  app.post('/manychat/restaurar-padrao', requireAdminAuth, async (req, res) => {
    await salvar((mc) => {
      const existentes = new Set(mc.regras.map((r) => r.nome));
      REGRAS_PADRAO.filter((r) => !existentes.has(r.nome)).forEach((r) => mc.regras.push(novaRegra(r)));
    });
    res.redirect('/manychat?msg=salvo#regras');
  });

  app.post('/manychat/log/limpar', requireAdminAuth, async (req, res) => {
    await salvar((mc) => { mc.log = []; });
    res.redirect('/manychat?msg=salvo#log');
  });

  app.post('/manychat/testar', requireAdminAuth, (req, res) => {
    const canal = CANAIS.includes(req.body.canal) ? req.body.canal : 'comentario';
    const ref = clean(req.body.media_id, 300);
    const extras = shortcode(ref) ? { permalink: ref } : { media_id: ref };
    res.json(simular(store.load(), fullDeps(), canal, clean(req.body.texto, 500), extras));
  });

  // Called by n8n for every comment / Direct / story reply on @festacrewolada.
  // Body: { tipo: comentario|dm|story, texto, usuario, nome, sender_id, comment_id, media_id, permalink }
  app.post('/api/n8n/manychat', async (req, res) => {
    const secret = process.env.N8N_CALLBACK_SECRET;
    if (secret && req.headers['x-callback-secret'] !== secret) return res.status(401).json({ error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    const canal = CANAIS.includes(b.tipo) ? b.tipo : null;
    if (!canal) return res.status(400).json({ error: 'tipo deve ser comentario, dm ou story' });
    const msg = {
      texto: clean(b.texto, 1000),
      usuario: clean(b.usuario, 60).replace(/^@/, ''),
      nome: clean(b.nome, 80),
      sender_id: clean(b.sender_id, 60),
      comment_id: clean(b.comment_id, 60),
      media_id: clean(b.media_id, 60),
      permalink: clean(b.permalink, 300),
    };
    const contaPropria = (process.env.INSTAGRAM_USERNAME || 'festacrewolada').toLowerCase();

    const resultado = await store.withDb((db) => {
      const mc = getMC(db);
      const agora = Date.now();
      const registrar = (extra) => {
        mc.log.unshift({ em: new Date(agora).toISOString(), canal, usuario: msg.usuario, texto: msg.texto.slice(0, 200), ...extra });
        mc.log.length = Math.min(mc.log.length, MAX_LOG);
        db.manychat = mc;
      };
      if (!mc.ativo) return { ativo: false, match: false };
      // Our own comments/replies come back through the webhook: never answer them.
      if (msg.usuario && msg.usuario.toLowerCase() === contaPropria) return { ativo: true, match: false, motivo: 'conta_propria' };

      const regra = encontrarRegra(mc.regras, canal, msg);
      if (!regra) {
        if (canal !== 'dm') registrar({ regra: null });
        return { ativo: true, match: false };
      }
      // Meta retries webhooks and the same person may comment several times.
      const chave = canal === 'comentario' && msg.comment_id
        ? 'c:' + msg.comment_id
        : `u:${msg.sender_id || msg.usuario}:${regra.id}`;
      const visto = mc.vistos[chave];
      if (visto && (chave.startsWith('c:') || agora - visto < COOLDOWN_MS)) {
        return { ativo: true, match: false, motivo: 'repetido', regra: { id: regra.id, nome: regra.nome } };
      }
      mc.vistos[chave] = agora;
      const chaves = Object.keys(mc.vistos);
      if (chaves.length > MAX_VISTOS) chaves.sort((a, z) => mc.vistos[a] - mc.vistos[z]).slice(0, chaves.length - MAX_VISTOS).forEach((k) => delete mc.vistos[k]);

      regra.disparos = (regra.disparos || 0) + 1;
      regra.ultimoDisparo = new Date(agora).toISOString();
      registrar({ regra: regra.nome });
      return { ativo: true, match: true, regra: { id: regra.id, nome: regra.nome }, ...montarResposta(regra, canal, msg, fullDeps(), mc) };
    });
    res.json(resultado);
  });

  // Rules as JSON (debug / other automations).
  app.get('/api/n8n/manychat/regras', (req, res) => {
    const secret = process.env.N8N_CALLBACK_SECRET;
    if (secret && req.headers['x-callback-secret'] !== secret) return res.status(401).json({ error: 'unauthorized' });
    const mc = getMC(store.load());
    res.json({ ativo: mc.ativo, regras: mc.regras.map(({ disparos, ultimoDisparo, ...r }) => r) });
  });
}

module.exports = { registerManychatRoutes, simular, encontrarRegra, norm, REGRAS_PADRAO };
