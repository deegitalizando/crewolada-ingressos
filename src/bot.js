const crypto = require('crypto');
const store = require('./store');
const { EVENTS, currentEvent, eventStatus, salesHeldBack, salesOpensAt } = require('./event');
const { getProducts, getChildRules } = require('./produtos');

// Knowledge base of the Crewolada AI agent (Instagram Direct, run by the n8n
// "Crewolada - Agente Instagram" workflow). The panel lives on bot.<dominio>/bot:
// the team toggles the agent, writes extra instructions, adds knowledge entries
// and uploads files (PDF, Word, text) whose text is extracted and kept here.
// n8n reads everything already assembled from /api/bot/conhecimento.

const MAX_ITEM = 6000;
const MAX_FILE_TEXT = 40000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT = 60000;

const clean = (v, max) => String(v || '').replace(/\r/g, '').trim().slice(0, max);
const brl = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');

function getBot(db) {
  const b = db.bot || {};
  return {
    agenteAtivo: b.agenteAtivo !== false,
    instrucoes: b.instrucoes || '',
    itens: Array.isArray(b.itens) ? b.itens : [],
    arquivos: Array.isArray(b.arquivos) ? b.arquivos : [],
  };
}

async function extractText(nome, buffer) {
  const ext = String(nome).toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    // pdf.js (Mozilla) ships as ESM only, hence the dynamic import.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
    let text = '';
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      text += content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n\n';
    }
    await doc.destroy();
    return text;
  }
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    return (await mammoth.extractRawText({ buffer })).value;
  }
  if (['txt', 'md', 'csv'].includes(ext)) return buffer.toString('utf8');
  throw new Error('Formato não suportado. Envie PDF, Word (.docx), TXT, MD ou CSV.');
}

// Events the agent may talk about: the one on sale and every upcoming one, with
// what a visitor needs (when, where, prices, how many tickets are left, where to buy).
function eventosTexto({ salesOpenNow, availableNow, vagasLivres, baseUrl }) {
  const now = Date.now();
  const linhas = [];
  EVENTS
    .filter((e) => !e.hidden && (!e.startAt || Date.parse(e.startAt) + 5 * 3600000 > now))
    .sort((a, b) => String(a.startAt || '9999').localeCompare(String(b.startAt || '9999')))
    .forEach((e) => {
      const atual = e.id === currentEvent.id;
      const partes = [`EVENTO: ${e.name}`, `Data: ${e.dateLabel}${e.timeLabel ? ` · ${e.timeLabel}` : ''}`];
      if (e.venue) partes.push(`Local: ${e.venue}`);
      if (e.cancelledAt) {
        partes.push(`EVENTO CANCELADO. Motivo: ${e.cancelReason || 'não informado'}. Quem comprou recebe o reembolso integral em até 7 dias corridos, no mesmo meio de pagamento, e é avisado por e-mail. Não incentive nenhuma compra e não diga que o evento vai acontecer.`);
        linhas.push(partes.join('\n'));
        return;
      }
      if (e.tagline) partes.push(`Destaque: ${e.tagline}${e.note ? ` (${e.note})` : ''}`);
      if (e.free) {
        partes.push(`Entrada gratuita com inscrição obrigatória (vagas limitadas${e.capacity ? `: ${e.capacity}` : ''}, 1 ingresso por pessoa: cada pessoa faz a própria inscrição com nome, CPF, WhatsApp e e-mail).`);
        const vagas = vagasLivres ? vagasLivres(e.id) : null;
        if (vagas === 0) partes.push('VAGAS ESGOTADAS no momento: não há inscrições disponíveis. Indique a comunidade do WhatsApp para saber se abrirem novas vagas.');
        else partes.push(`Inscrição: ${baseUrl}/${e.slug}${vagas !== null ? ` · restam ${vagas} vagas` : ''}`);
      } else if (atual) {
        const produtos = getProducts(e);
        if (produtos.length) {
          produtos.forEach((p) => partes.push(`${p.name}: ${brl(p.price)}${p.includes.length ? ` (inclui ${p.includes.join(', ')})` : ''}`));
          const r = getChildRules(e);
          partes.push(`Crianças até ${r.freeUntil} anos não pagam; de ${r.freeUntil + 1} a ${r.halfUntil} anos pagam meia.`);
        }
        const left = availableNow();
        if (!salesOpenNow()) {
          partes.push(salesHeldBack(e)
            ? `Vendas ainda não abertas. Abrem em ${new Date(salesOpensAt(e)).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`
            : 'Vendas encerradas.');
        } else if (left !== null && left <= 0) {
          partes.push('INGRESSOS ESGOTADOS: as vendas estão encerradas.');
        } else {
          partes.push(`Vendas abertas em ${baseUrl}${left !== null ? ` · restam ${left} ingressos` : ''}. Pagamento por Pix ou cartão.`);
        }
      } else {
        partes.push('Ingressos ainda não estão à venda (avisamos na comunidade do WhatsApp e no Instagram).');
      }
      partes.push(`Situação: ${eventStatus(e) === 'atual' ? 'evento atual' : 'próximo evento'}`);
      linhas.push(partes.join('\n'));
    });
  const proximos = linhas.length ? linhas.join('\n\n') : 'Nenhum evento anunciado no momento.';

  // Past editions: history the agent can talk about (never sold anymore).
  const passados = EVENTS
    .filter((e) => !e.hidden && e.startAt && Date.parse(e.startAt) + 5 * 3600000 <= now)
    .sort((a, b) => String(b.startAt).localeCompare(String(a.startAt)))
    .map((e) => `- ${e.name}: ${e.dateLabel}${e.timeLabel ? ` · ${e.timeLabel}` : ''}${e.venue ? ` · ${e.venue}` : ''}${e.free ? ' (entrada gratuita)' : ''}`);
  return proximos + (passados.length
    ? `\n\n## EVENTOS QUE JÁ ACONTECERAM (só histórico: não há ingressos à venda para eles)\n${passados.join('\n')}`
    : '');
}

function avisosCancelamento() {
  const now = Date.now();
  return EVENTS
    .filter((e) => e.cancelledAt && (!e.startAt || Date.parse(e.startAt) + 5 * 3600000 > now - 30 * 86400000))
    .map((e) => `- O evento ${e.name} (${e.dateLabel}${e.venue ? ', ' + e.venue : ''}) foi CANCELADO. Motivo: ${(String(e.cancelReason || 'não informado').replace(/[.\s]+$/, '') || 'não informado')}. Quem comprou ou se inscreveu recebe aviso por e-mail; nas compras pagas o valor é reembolsado integralmente em até 7 dias corridos, no mesmo meio de pagamento. Se perguntarem sobre esse evento, informe o cancelamento e o motivo com educação, peça desculpas e nunca incentive compra ou diga que ele vai acontecer. Dúvidas sobre o reembolso: contato@crewolada.com.`);
}

function contexto(db, deps) {
  const bot = getBot(db);
  const { baseUrl, communityUrl, whatsappTicketUrl, whatsappLabel } = deps;
  const avisos = avisosCancelamento();
  const partes = [
    ...(avisos.length ? ['## AVISO IMPORTANTE: EVENTOS CANCELADOS', avisos.join('\n')] : []),
    '## EVENTOS (dados do site, atualizados agora)',
    eventosTexto(deps),
    '## COMO RECEBER O INGRESSO',
    [
      '- Assim que o pagamento é aprovado, o ingresso (PDF com QR Code) chega no e-mail informado na compra. Vale olhar a caixa de spam e promoções.',
      `- Para receber também no WhatsApp: mande "Quero receber meu ingresso da Crewolada" para o nosso WhatsApp ${whatsappLabel} (${whatsappTicketUrl}). Se o número for diferente do usado na compra, nosso atendimento pede o CPF.`,
      `- Também dá para ver os ingressos a qualquer momento em ${baseUrl}/meus-ingressos.`,
      '- Na entrada, basta apresentar o QR Code (impresso ou no celular). Cada ingresso vale uma entrada e é pessoal.',
    ].join('\n'),
    '## OUTROS LINKS',
    [
      `- Comunidade no WhatsApp (novidades em primeira mão): ${communityUrl}`,
      `- Levar a Crewolada para um evento (DJ ou festa completa): ${baseUrl}/contato`,
      `- Nossa história: ${baseUrl}/sobre`,
      `- Todos os links: ${baseUrl}/links`,
    ].join('\n'),
  ];
  if (bot.itens.length) {
    partes.push('## INFORMAÇÕES CADASTRADAS PELA EQUIPE');
    bot.itens.forEach((i) => partes.push(`### ${i.titulo}\n${i.texto}`));
  }
  if (bot.arquivos.length) {
    partes.push('## CONTEÚDO DOS ARQUIVOS ENVIADOS PELA EQUIPE');
    bot.arquivos.forEach((a) => partes.push(`### ${a.nome}\n${a.texto}`));
  }
  return partes.join('\n\n').slice(0, MAX_CONTEXT);
}

function registerBotRoutes(app, { requireAdminAuth, eventInfo, deps }) {
  const baseUrl = () => (process.env.BASE_URL || 'https://crewolada.com').replace(/\/$/, '');
  const fullDeps = () => ({ ...deps, baseUrl: baseUrl() });

  app.get('/bot', requireAdminAuth, (req, res) => {
    const db = store.load();
    const bot = getBot(db);
    const ctx = contexto(db, fullDeps());
    res.render('admin_bot', {
      eventInfo, bot, ctx, ctxLen: ctx.length, maxContext: MAX_CONTEXT, maxFileMb: MAX_FILE_BYTES / 1024 / 1024,
      msg: req.query.msg || null,
    });
  });

  app.post('/bot/geral', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      db.bot = { ...getBot(db), agenteAtivo: req.body.agenteAtivo === 'on', instrucoes: clean(req.body.instrucoes, MAX_ITEM) };
    });
    res.redirect('/bot?msg=salvo');
  });

  app.post('/bot/itens', requireAdminAuth, async (req, res) => {
    const titulo = clean(req.body.titulo, 120);
    const texto = clean(req.body.texto, MAX_ITEM);
    if (!titulo || !texto) return res.redirect('/bot?msg=item_vazio');
    const id = clean(req.body.id, 40);
    await store.withDb((db) => {
      const bot = getBot(db);
      const agora = new Date().toISOString();
      const i = bot.itens.findIndex((x) => x.id === id);
      if (id && i !== -1) bot.itens[i] = { ...bot.itens[i], titulo, texto, atualizadoEm: agora };
      else bot.itens.push({ id: crypto.randomUUID(), titulo, texto, criadoEm: agora });
      db.bot = bot;
    });
    res.redirect('/bot?msg=salvo#itens');
  });

  app.post('/bot/itens/:id/excluir', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      const bot = getBot(db);
      bot.itens = bot.itens.filter((x) => x.id !== req.params.id);
      db.bot = bot;
    });
    res.redirect('/bot?msg=excluido#itens');
  });

  // The page sends the file as base64 JSON (no multipart parser in this app).
  app.post('/bot/arquivos', requireAdminAuth, async (req, res) => {
    try {
      const nome = clean(req.body.nome, 140);
      const buffer = Buffer.from(String(req.body.base64 || ''), 'base64');
      if (!nome || !buffer.length) return res.status(400).json({ error: 'Arquivo vazio.' });
      if (buffer.length > MAX_FILE_BYTES) return res.status(400).json({ error: `Arquivo maior que ${MAX_FILE_BYTES / 1024 / 1024} MB.` });
      const texto = clean(await extractText(nome, buffer), MAX_FILE_TEXT).replace(/\n{3,}/g, '\n\n');
      if (texto.length < 20) return res.status(400).json({ error: 'Não encontrei texto nesse arquivo. Se for um PDF de imagem (escaneado), envie a versão em texto.' });
      await store.withDb((db) => {
        const bot = getBot(db);
        bot.arquivos.push({ id: crypto.randomUUID(), nome, tamanho: buffer.length, texto, criadoEm: new Date().toISOString() });
        db.bot = bot;
      });
      return res.json({ ok: true, caracteres: texto.length, cortado: texto.length >= MAX_FILE_TEXT });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Não foi possível ler o arquivo.' });
    }
  });

  app.post('/bot/arquivos/:id/excluir', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      const bot = getBot(db);
      bot.arquivos = bot.arquivos.filter((x) => x.id !== req.params.id);
      db.bot = bot;
    });
    res.redirect('/bot?msg=excluido#arquivos');
  });

  // Read by the n8n agent on every message (same shared secret as the other n8n callbacks).
  app.get('/api/bot/conhecimento', (req, res) => {
    const secret = process.env.N8N_CALLBACK_SECRET;
    if (secret && req.headers['x-callback-secret'] !== secret) return res.status(401).json({ error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    const db = store.load();
    const bot = getBot(db);
    res.json({ ativo: bot.agenteAtivo, instrucoes: bot.instrucoes, contexto: contexto(db, fullDeps()) });
  });
}

module.exports = { registerBotRoutes, MAX_FILE_BYTES };
