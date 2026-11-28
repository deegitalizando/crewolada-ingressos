const crypto = require('crypto');
const axios = require('axios');
const store = require('./store');
const { EVENTS, currentEvent, getEventById, orderEventId, eventForOrder } = require('./event');
const { notifyOrderApproved } = require('./n8n');

// ---------------------------------------------------------------------------
// Robô da Crewolada na central de atendimento (WhatsApp oficial da Meta).
//
// The central (Pede Cardápio platform, crewolada.com/bot) receives the WhatsApp
// messages of the Crewolada number and POSTs each one here (X-Deeg-Signature =
// HMAC-SHA256 of the body with the bot API key). We answer by calling the
// central's POST /api/v1/messages with the same key. Text only, so tickets go
// as links to /ingresso/<code> (QR Code + PDF download) and the PDF is also
// re-sent by e-mail.
//
//   - "quero meu ingresso", CPF or e-mail in the message -> finds the tickets
//     (by WhatsApp number, CPF or e-mail) and sends the links;
//   - anything else -> the party's key info (date, place, price, link), at most
//     once every 12 h per person, so a human can take over the conversation.
// ---------------------------------------------------------------------------

const PEDIU_INGRESSO = /(ingress|qr ?code|qrcode|bilhete|\bpdf\b|nao (recebi|chegou)|nao veio|comprei|minha entrada|meu convite|inscricao|inscrevi|cortesia|meus ingressos)/;
const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
const GENERICA_CADA_MS = 12 * 3600 * 1000;
const MAX_LOG = 300;
const JANELA_MS = 23 * 3600 * 1000; // Meta: free text only up to 24 h after the customer's last message

// Approved templates used outside the 24 h window. Parameters can't have line breaks.
const MODELOS = {
  ingresso: {
    name: 'crewolada_ingresso',
    category: 'UTILITY',
    body: 'Olá, {{1}}! Desculpe a demora em responder. Aqui está o seu ingresso da Crewolada: {{2}} . Abra o link para ver o QR Code e baixar o PDF. Na entrada é só mostrar o QR Code.',
    example: ['Maria', 'https://crewolada.com/ingresso/ABC123'],
  },
  retorno: {
    name: 'crewolada_retorno',
    category: 'UTILITY',
    body: 'Olá, {{1}}! Desculpe a demora em responder a sua mensagem para a Crewolada. Se ainda precisar do seu ingresso ou de alguma informação sobre a festa, é só responder esta mensagem que atendemos por aqui.',
    example: ['Maria'],
  },
};
const apiBase = (c) => c.apiUrl.replace(/\/api\/v1\/messages$/, '');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');
const suffix = (p) => digits(p).slice(-10);
const baseUrl = () => (process.env.BASE_URL || 'https://crewolada.com').replace(/\/$/, '');
const primeiroNome = (n) => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : ''; };
const brl = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');

function getCentral(db) {
  const c = db.central || {};
  return {
    ativo: c.ativo !== false,
    apiUrl: c.apiUrl || process.env.CENTRAL_API_URL || 'https://cardapio.deegitalizando.com/api/v1/messages',
    apiKey: c.apiKey || process.env.CENTRAL_API_KEY || '',
    genericas: c.genericas && typeof c.genericas === 'object' ? c.genericas : {},
    vistos: Array.isArray(c.vistos) ? c.vistos : [],
    log: Array.isArray(c.log) ? c.log : [],
  };
}

async function mutate(fn) {
  return store.withDb((db) => {
    const c = getCentral(db);
    const raw = db.central || {};
    const out = fn(c, raw);
    // Only what the admin typed is stored; the .env fallbacks are never copied in.
    db.central = { ...raw, genericas: c.genericas, vistos: c.vistos.slice(-500), log: c.log.slice(0, MAX_LOG) };
    return out;
  });
}

async function registrar(entry) {
  await mutate((c) => { c.log.unshift({ ts: new Date().toISOString(), ...entry }); }).catch(() => {});
}

// ---------------------------------------------------------------- tickets

// Paid, live tickets of this person: buyer by phone/CPF/e-mail, or companion named on a ticket.
function acharIngressos(db, { phone, cpf, email }) {
  const ph = phone ? suffix(phone) : '';
  const same = (p, c, e) => (ph && suffix(p) === ph)
    || (cpf && digits(c) === cpf)
    || (email && String(e || '').trim().toLowerCase() === email);
  const achados = [];
  Object.values(db.orders || {}).forEach((o) => {
    if (o.status !== 'paid') return;
    const ev = eventForOrder(o);
    if (ev.cancelledAt) return;
    const vivos = Object.values(db.tickets || {}).filter((t) => t.orderId === o.id && t.status !== 'cancelled')
      .sort((a, b) => (a.drawNumber || 0) - (b.drawNumber || 0));
    if (!vivos.length) return;
    if (same(o.buyerPhone, o.buyerCpf, o.buyerEmail)) { achados.push({ order: o, tickets: vivos, ev }); return; }
    const meus = vivos.filter((t) => t.participantName && same(t.participantPhone, t.participantCpf, t.participantEmail));
    if (meus.length) achados.push({ order: o, tickets: meus, ev, to: { nome: meus[0].participantName, email: meus[0].participantEmail || '', whatsapp: '' } });
  });
  const agora = Date.now();
  const futuro = (ev) => !ev.startAt || Date.parse(ev.startAt) + 6 * 3600000 > agora;
  const proximos = achados.filter((a) => futuro(a.ev));
  return proximos.length ? proximos : achados;
}

function textoIngressos(achados, nome) {
  const linhas = [];
  const total = achados.reduce((n, a) => n + a.tickets.length, 0);
  linhas.push(`Encontrei, ${primeiroNome(nome) || 'tudo certo'}! 🎉 ${total === 1 ? 'Aqui está o seu ingresso' : `Aqui estão os seus ${total} ingressos`}:`);
  achados.forEach((a) => {
    linhas.push(`\n*${a.ev.name}* · ${a.ev.dateLabel}${a.ev.timeLabel ? ` · ${a.ev.timeLabel}` : ''}`);
    a.tickets.forEach((t) => {
      const quem = t.participantName ? ` (${t.participantName})` : '';
      linhas.push(`🎟️ ${baseUrl()}/ingresso/${t.code}${quem}`);
    });
  });
  linhas.push('\nAbra o link para ver o QR Code e baixar o PDF. Na entrada é só mostrar o QR Code 😉 Também reenviei para o seu e-mail.');
  return linhas.join('\n');
}

// ---------------------------------------------------------------- party info

function textoFesta(nome, deps) {
  const ev = currentEvent;
  const partes = [`Oi${primeiroNome(nome) ? `, ${primeiroNome(nome)}` : ''}! Aqui é a Crewolada 🖤`];
  if (ev.cancelledAt) {
    partes.push(`O evento *${ev.name}* foi cancelado. Quem comprou recebe o reembolso integral em até 7 dias corridos. Dúvidas: contato@crewolada.com`);
  } else {
    partes.push(`Nossa próxima festa é a *${ev.name}*: ${ev.dateLabel}${ev.timeLabel ? `, às ${ev.timeLabel}` : ''}${ev.venue ? `, no ${ev.venue}` : ''}.`);
    const info = deps && deps.infoVenda ? deps.infoVenda() : null;
    const link = ev.paths && ev.paths[0] ? `${baseUrl()}/${ev.paths[0]}` : baseUrl();
    if (info && info.esgotado) partes.push('Os ingressos esgotaram 😕');
    else partes.push(`🎟️ Ingressos${info && info.preco ? ` (${typeof info.preco === 'number' ? brl(info.preco) : info.preco})` : ''}, no Pix ou cartão: ${link}`);
  }
  partes.push('Já comprou? Mande *"Quero meu ingresso"* que eu te envio por aqui.');
  partes.push(`Novidades em primeira mão na comunidade: ${process.env.COMMUNITY_URL || 'https://chat.whatsapp.com/IfH31ObCm3o66OHOM46oup'}`);
  partes.push('Se for outra dúvida, pode escrever que alguém da equipe te responde por aqui. 🙌');
  return partes.join('\n\n');
}

// ---------------------------------------------------------------- send

async function enviar(c, to, text) {
  await axios.post(c.apiUrl, { to, text }, { headers: { Authorization: `Bearer ${c.apiKey}` }, timeout: 20000 });
}

// Approved template (outside the 24 h window). `preview` is the filled text kept in the central's history.
async function enviarModelo(c, to, modelo, params) {
  const preview = params.reduce((t, p, i) => t.replace(`{{${i + 1}}}`, p), modelo.body);
  await axios.post(c.apiUrl, { to, text: preview, template: { name: modelo.name, language: 'pt_BR', params } }, { headers: { Authorization: `Bearer ${c.apiKey}` }, timeout: 20000 });
}

let deps = {};

async function processar(ev) {
  const db = store.load();
  const c = getCentral(db);
  if (!c.ativo || !c.apiKey) return;
  const texto = String(ev.text || '');
  const t = norm(texto);
  const to = ev.conversationId || ev.from;
  const cpf = (texto.match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/) || [''])[0].replace(/\D/g, '');
  const email = ((texto.match(EMAIL_RE) || [''])[0] || '').toLowerCase();
  const pediu = PEDIU_INGRESSO.test(t) || cpf.length === 11 || Boolean(email);
  // Waiting more than ~24 h (messages re-delivered by /api/v1/pendentes): only approved templates may go out.
  const desde = Date.parse(ev.pendingSince || ev.timestamp || 0) || Date.now();
  const foraDaJanela = Date.now() - desde > JANELA_MS;
  const nomeParam = primeiroNome(ev.name) || 'tudo bem';

  try {
    if (pediu) {
      const achados = acharIngressos(db, { phone: ev.from, cpf: cpf.length === 11 ? cpf : '', email });
      if (achados.length) {
        const nome = (achados[0].to && achados[0].to.nome) || achados[0].order.buyerName || ev.name;
        if (foraDaJanela) {
          const links = achados.flatMap((a) => a.tickets.map((tk) => `${baseUrl()}/ingresso/${tk.code}`)).join(' | ');
          await enviarModelo(c, to, MODELOS.ingresso, [primeiroNome(nome) || nomeParam, links]);
        } else {
          await enviar(c, to, textoIngressos(achados, nome));
        }
        // The PDF also goes by e-mail (the n8n flow; e-mail only).
        achados.forEach((a) => notifyOrderApproved(a.order, a.tickets, { origin: 'reenvio', channel: 'email', to: a.to || null })
          .catch((err) => console.error('[central] reenvio por e-mail falhou:', err.message)));
        await registrar({ de: ev.from, nome: ev.name, texto, acao: 'ingresso enviado', ingressos: achados.reduce((n, a) => n + a.tickets.length, 0) });
        return;
      }
      if (foraDaJanela) {
        await enviarModelo(c, to, MODELOS.retorno, [nomeParam]);
        await registrar({ de: ev.from, nome: ev.name, texto, acao: 'ingresso não encontrado (modelo de retorno)' });
        return;
      }
      const resp = cpf.length === 11 || email
        ? 'Não encontrei ingresso com esse dado 😕 Confira se é o mesmo CPF ou e-mail usado na compra/inscrição e me mande de novo (só ele na mensagem). Se preferir, veja em ' + baseUrl() + '/meus-ingressos'
        : `Não encontrei ingresso no número deste WhatsApp 😕 Me manda o *CPF* ou o *e-mail* usado na compra/inscrição (só ele na mensagem) que eu procuro. Também dá para ver em ${baseUrl()}/meus-ingressos`;
      await enviar(c, to, resp);
      await registrar({ de: ev.from, nome: ev.name, texto, acao: 'ingresso não encontrado' });
      return;
    }
    // General message: the party info, once every 12 h per person (then a human answers).
    const ultima = Date.parse(c.genericas[ev.from] || 0) || 0;
    if (Date.now() - ultima < GENERICA_CADA_MS) {
      await registrar({ de: ev.from, nome: ev.name, texto, acao: 'sem resposta automática (para a equipe)' });
      return;
    }
    await mutate((x) => { x.genericas[ev.from] = new Date().toISOString(); });
    if (foraDaJanela) await enviarModelo(c, to, MODELOS.retorno, [nomeParam]);
    else await enviar(c, to, textoFesta(ev.name, deps));
    await registrar({ de: ev.from, nome: ev.name, texto, acao: 'informações da festa' });
  } catch (err) {
    const msg = (err.response && err.response.data && (err.response.data.error || JSON.stringify(err.response.data))) || err.message;
    console.error('[central] falha ao responder:', msg);
    await registrar({ de: ev.from, nome: ev.name, texto, acao: 'erro', erro: String(msg).slice(0, 300) });
  }
}

function resumo(db) {
  const c = getCentral(db);
  return {
    ativo: c.ativo,
    apiUrl: c.apiUrl,
    temChave: Boolean(c.apiKey),
    chaveMask: c.apiKey ? `deeg_••••${c.apiKey.slice(-4)}` : '',
    urlRobo: `${baseUrl()}/api/central/mensagem`,
    log: c.log.slice(0, 50),
  };
}

function registerCentralRoutes(app, { requireAdminAuth, deps: d = {} }) {
  deps = d;

  app.post('/api/central/mensagem', (req, res) => {
    const c = getCentral(store.load());
    if (!c.apiKey) return res.status(503).json({ error: 'robô sem chave configurada' });
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const sig = String(req.headers['x-deeg-signature'] || '');
    const esperado = 'sha256=' + crypto.createHmac('sha256', c.apiKey).update(raw).digest('hex');
    if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) {
      return res.status(401).json({ error: 'assinatura inválida' });
    }
    const ev = req.body || {};
    res.json({ ok: true }); // answer the central fast; the reply goes through its API
    if (ev.event !== 'message' || !ev.from) return;
    const id = ev.messageId || `${ev.from}:${ev.timestamp}`;
    mutate((x) => { if (x.vistos.includes(id)) return false; x.vistos.push(id); return true; })
      .then((novo) => { if (novo) return processar(ev); return null; })
      .catch((err) => console.error('[central] erro:', err.message));
  });

  app.post('/admin/automacoes/central', requireAdminAuth, async (req, res) => {
    await mutate((c, raw) => {
      raw.ativo = req.body.ativo === 'on';
      const url = String(req.body.apiUrl || '').trim();
      if (/^https:\/\/.+\/api\/v1\/messages$/.test(url)) raw.apiUrl = url;
      const key = String(req.body.apiKey || '').trim();
      if (/^deeg_\w{10,}$/.test(key)) raw.apiKey = key;
    });
    res.redirect('/admin/automacoes?aba=config&msg=' + encodeURIComponent('Robô da central salvo.') + '#central');
  });

  const erroDe = (err) => (err.response && err.response.data && err.response.data.error) || err.message;
  const voltar = (res, tipo, txt) => res.redirect(`/admin/automacoes?aba=config&${tipo}=${encodeURIComponent(txt)}#central`);

  // Creates the two Crewolada templates in the Meta account (through the central) and shows their status.
  app.post('/admin/automacoes/central/modelos', requireAdminAuth, async (req, res) => {
    const c = getCentral(store.load());
    if (!c.apiKey) return voltar(res, 'erro', 'Salve a chave da central primeiro.');
    const h = { headers: { Authorization: `Bearer ${c.apiKey}` }, timeout: 30000 };
    try {
      const { data } = await axios.get(`${apiBase(c)}/api/v1/templates`, h);
      const existentes = new Map((data.templates || []).map((tp) => [tp.name, tp.status]));
      const status = [];
      for (const m of Object.values(MODELOS)) {
        if (!existentes.has(m.name)) {
          await axios.post(`${apiBase(c)}/api/v1/templates`, { name: m.name, category: m.category, language: 'pt_BR', body: m.body, example: m.example }, h);
          status.push(`${m.name}: enviado para aprovação`);
        } else status.push(`${m.name}: ${existentes.get(m.name)}`);
      }
      return voltar(res, 'msg', `Modelos: ${status.join(' · ')}. A aprovação da Meta costuma levar de minutos a algumas horas (APPROVED = aprovado).`);
    } catch (err) {
      return voltar(res, 'erro', `Não consegui criar/ver os modelos: ${erroDe(err)}. A central precisa estar atualizada.`);
    }
  });

  // Asks the central to re-deliver every unanswered conversation of the last N days to this bot.
  app.post('/admin/automacoes/central/pendentes', requireAdminAuth, async (req, res) => {
    const c = getCentral(store.load());
    if (!c.apiKey || !c.ativo) return voltar(res, 'erro', 'Ligue o robô e salve a chave da central primeiro.');
    const dias = Math.min(30, Math.max(1, parseInt(req.body.dias, 10) || 7));
    try {
      const { data } = await axios.post(`${apiBase(c)}/api/v1/pendentes`, { dias }, { headers: { Authorization: `Bearer ${c.apiKey}` }, timeout: 120000 });
      return voltar(res, 'msg', `${data.conversas} conversa(s) sem resposta entregues ao robô. As respostas aparecem em "Últimas mensagens atendidas" e no crewolada.com/bot.`);
    } catch (err) {
      return voltar(res, 'erro', `A central não aceitou: ${erroDe(err)}. A central precisa estar atualizada.`);
    }
  });

  app.post('/admin/automacoes/central/testar', requireAdminAuth, async (req, res) => {
    const c = getCentral(store.load());
    const numero = digits(req.body.numero);
    if (!c.apiKey || numero.length < 10) return res.redirect('/admin/automacoes?aba=config&erro=' + encodeURIComponent('Salve a chave e informe um número com DDD.') + '#central');
    const to = numero.length <= 11 ? `55${numero}` : numero;
    try {
      await enviar(c, to, 'Teste do robô da Crewolada pela central ✅');
      return res.redirect('/admin/automacoes?aba=config&msg=' + encodeURIComponent(`Mensagem de teste enviada para ${to}.`) + '#central');
    } catch (err) {
      const msg = (err.response && err.response.data && err.response.data.error) || err.message;
      return res.redirect('/admin/automacoes?aba=config&erro=' + encodeURIComponent(`A central recusou: ${msg}. (Fora da janela de 24 h a Meta só aceita modelos aprovados: mande antes um "oi" desse número para a Crewolada.)`) + '#central');
    }
  });
}

module.exports = { registerCentralRoutes, resumo, _internals: { acharIngressos, textoIngressos, textoFesta, processar, PEDIU_INGRESSO } };
