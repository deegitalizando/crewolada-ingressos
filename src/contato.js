const crypto = require('crypto');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const store = require('./store');
const { normalizePhone } = require('./n8n');

// "Quiz" contact page (/contato) to receive invitations: someone who wants the
// DJ or the whole Crewolada party at their event. Every submission is saved
// (db.contatos) and e-mailed to the team inbox through the same n8n e-mail
// flow that delivers tickets, with a PDF summary attached.
const INBOX = () => process.env.CONTACT_INBOX_EMAIL || 'contatofestacrewolada@gmail.com';

const OPCOES = {
  tipoEvento: ['Culto, igreja ou congresso', 'Festa ou balada', 'Aniversário ou casamento', 'Show ou festival', 'Evento institucional ou corporativo', 'Outro'],
  convidar: ['Só o DJ Dee', 'A festa Crewolada completa', 'Ainda não sei, quero entender as opções'],
  bilhetado: ['Sim, com venda de ingressos', 'Não, entrada gratuita', 'Evento fechado para convidados'],
  publico: ['Até 100 pessoas', '100 a 300', '300 a 800', '800 a 2.000', 'Mais de 2.000'],
  estrutura: ['Sim, som e iluminação completos', 'Só tem som', 'Só tem iluminação', 'Não tem estrutura', 'Não sei informar'],
  precisaEstrutura: ['Sim, preciso de orçamento da estrutura', 'Não, nós providenciamos'],
  duracao: ['Até 1 hora', '2 horas', '3 horas ou mais', 'A combinar'],
  orcamento: ['Já tenho um valor em mente', 'Quero receber uma proposta', 'Evento beneficente, a combinar'],
  deslocamento: ['Cobrimos transporte e hospedagem', 'A combinar', 'Evento no Rio de Janeiro'],
  papel: ['Organizador(a)', 'Pastor(a) ou líder', 'Produtor(a)', 'Contratante ou empresa', 'Outro'],
};
const ESTRUTURA_COMPLETA = OPCOES.estrutura[0];

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 8;
}

const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const pick = (v, list) => (list.includes(String(v || '')) ? String(v) : '');
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function dateBR(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const wd = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(d);
  return `${m[3]}/${m[2]}/${m[1]} (${wd})`;
}

function validate(body) {
  const v = {
    tipoEvento: pick(body.tipoEvento, OPCOES.tipoEvento),
    convidar: pick(body.convidar, OPCOES.convidar),
    data: /^\d{4}-\d{2}-\d{2}$/.test(String(body.data || '')) ? String(body.data) : '',
    dataIndefinida: body.dataIndefinida === 'on' || body.dataIndefinida === '1',
    cidade: clean(body.cidade, 60),
    uf: UFS.includes(String(body.uf || '').toUpperCase()) ? String(body.uf).toUpperCase() : '',
    local: clean(body.local, 100),
    bilhetado: pick(body.bilhetado, OPCOES.bilhetado),
    publico: pick(body.publico, OPCOES.publico),
    estrutura: pick(body.estrutura, OPCOES.estrutura),
    precisaEstrutura: pick(body.precisaEstrutura, OPCOES.precisaEstrutura),
    inicio: /^\d{2}:\d{2}$/.test(String(body.inicio || '')) ? String(body.inicio) : '',
    duracao: pick(body.duracao, OPCOES.duracao),
    orcamento: pick(body.orcamento, OPCOES.orcamento),
    orcamentoValor: clean(body.orcamentoValor, 40),
    deslocamento: pick(body.deslocamento, OPCOES.deslocamento),
    detalhes: clean(body.detalhes, 1200),
    nome: clean(body.nome, 80),
    papel: pick(body.papel, OPCOES.papel),
    email: clean(body.email, 120).toLowerCase(),
    instagram: clean(body.instagram, 40).replace(/^@+/, ''),
    consent: body.consent === 'on' || body.consent === '1' || body.consent === true,
  };
  let phone = String(body.whatsapp || '').replace(/\D/g, '').replace(/^0+/, '');
  if (phone.length > 11 && phone.startsWith('55')) phone = phone.slice(2);
  v.whatsapp = phone;

  // Answers that don't apply must not be stored from a previous selection.
  if (v.estrutura === ESTRUTURA_COMPLETA) v.precisaEstrutura = '';
  if (v.uf === 'RJ') v.deslocamento = OPCOES.deslocamento[2];
  if (v.orcamento !== OPCOES.orcamento[0]) v.orcamentoValor = '';
  if (v.dataIndefinida) v.data = '';

  const errors = [];
  if (!v.tipoEvento) errors.push('Escolha o tipo de evento.');
  if (!v.convidar) errors.push('Diga quem você quer convidar.');
  if (!v.data && !v.dataIndefinida) errors.push('Informe a data (ou marque que ainda não definiu).');
  if (!v.cidade) errors.push('Informe a cidade do evento.');
  if (!v.uf) errors.push('Escolha o estado do evento.');
  if (!v.bilhetado) errors.push('Diga se o evento tem venda de ingressos.');
  if (!v.publico) errors.push('Escolha o público esperado.');
  if (!v.estrutura) errors.push('Informe a estrutura de som e iluminação.');
  if (v.nome.length < 2) errors.push('Informe seu nome.');
  if (!/^[1-9][1-9]\d{8,9}$/.test(v.whatsapp)) errors.push('Informe um WhatsApp válido, com DDD.');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.push('O e-mail informado não parece válido.');
  if (!v.consent) errors.push('Para enviar, é preciso concordar com o uso dos dados.');
  return { values: v, errors };
}

function describe(c, formatDatetime) {
  const when = c.dataIndefinida ? 'Data ainda não definida' : dateBR(c.data);
  const where = `${c.local ? c.local + ' · ' : ''}${c.cidade}/${c.uf}`;
  const lines = [
    ['Quem quer convidar', c.convidar],
    ['Tipo de evento', c.tipoEvento],
    ['Data', when],
    ['Local', where],
    ['Horário de início', c.inicio],
    ['Duração desejada', c.duracao],
    ['Evento com ingressos', c.bilhetado],
    ['Público esperado', c.publico],
    ['Som e iluminação', c.estrutura],
    ['Precisa de estrutura', c.precisaEstrutura],
    ['Orçamento', c.orcamento ? c.orcamento + (c.orcamentoValor ? ` (${c.orcamentoValor})` : '') : ''],
    ['Deslocamento e hospedagem', c.deslocamento],
    ['Detalhes', c.detalhes],
  ].filter(([, val]) => val);
  const contact = [
    ['Nome', c.nome + (c.papel ? ` (${c.papel})` : '')],
    ['WhatsApp', `+55 ${c.whatsapp}`],
    ['E-mail', c.email],
    ['Instagram', c.instagram ? '@' + c.instagram : ''],
    ['Recebido em', formatDatetime ? formatDatetime(c.createdAt) : c.createdAt],
  ].filter(([, val]) => val);
  return { lines, contact, when, where };
}

function buildPdf(c, formatDatetime) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (x) => chunks.push(x));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const { lines, contact } = describe(c, formatDatetime);
    const W = doc.page.width;
    const left = 56;
    const cw = W - left * 2;

    doc.rect(0, 0, W, 100).fill('#0a0a0a');
    doc.fillColor('#FFD21E').font('Helvetica-Bold').fontSize(24).text('Novo convite · Crewolada', left, 34, { width: cw });
    let y = 126;
    function section(title) {
      doc.fillColor('#c9911f').font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), left, y, { width: cw });
      y += 20;
    }
    function row(label, value) {
      doc.fillColor('#555555').font('Helvetica').fontSize(10).text(label, left, y, { width: 150 });
      doc.fillColor('#0a0a0a').font('Helvetica-Bold').fontSize(10).text(value, left + 160, y, { width: cw - 160 });
      y += Math.max(18, doc.heightOfString(value, { width: cw - 160 }) + 6);
    }
    section('Evento');
    lines.forEach(([l, val]) => row(l, val));
    y += 14;
    section('Contato');
    contact.forEach(([l, val]) => row(l, val));
    doc.end();
  });
}

function buildMessage(c, formatDatetime) {
  const { lines, contact } = describe(c, formatDatetime);
  const wa = `https://wa.me/55${c.whatsapp}`;
  const parts = [
    `Novo convite recebido pelo site (crewolada.com/contato).`,
    '',
    '— EVENTO —',
    ...lines.map(([l, val]) => `${l}: ${esc(val)}`),
    '',
    '— CONTATO —',
    ...contact.map(([l, val]) => `${l}: ${esc(val)}`),
    `Responder pelo WhatsApp: ${wa}`,
  ];
  return parts.join('\n');
}

async function sendInviteEmail(c, formatDatetime) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('N8N_WEBHOOK_URL não configurada.');
  const { when } = describe(c, formatDatetime);
  const pdf = await buildPdf(c, formatDatetime);
  await axios.post(
    webhookUrl,
    {
      nome: 'Equipe Crewolada',
      email: INBOX(),
      nomeLote: '',
      codigo: c.id.slice(0, 8).toUpperCase(),
      numeroSorteio: '',
      whatsapp: normalizePhone(c.whatsapp),
      pdfBase64: pdf.toString('base64'),
      fileName: `convite-${c.id.slice(0, 8)}.pdf`,
      mensagemPersonalizada: buildMessage(c, formatDatetime),
      assunto: `Novo convite: ${c.convidar} · ${c.cidade}/${c.uf} · ${c.dataIndefinida ? 'data a definir' : when.split(' ')[0]}`,
      origem: 'contato',
      canal: 'email',
    },
    { timeout: 15000 }
  );
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function registerContatoRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay }) {
  const base = { opcoes: OPCOES, ufs: UFS };

  app.get('/contato', (req, res) => {
    res.render('contato', { eventInfo, ...base, minDate: new Date().toISOString().slice(0, 10) });
  });

  // JSON endpoint used by the quiz (no page reload at the end).
  app.post('/api/contato', async (req, res) => {
    if (req.body.website) return res.json({ ok: true }); // honeypot: pretend it worked
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: 'Muitas tentativas em pouco tempo. Tente de novo mais tarde.' });

    const { values, errors } = validate(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    const contato = { id: crypto.randomUUID(), ...values, status: 'novo', createdAt: new Date().toISOString(), emailSentAt: null };
    await store.withDb((db) => {
      db.contatos = db.contatos || {};
      db.contatos[contato.id] = contato;
    });

    // The lead is saved either way; the e-mail is best effort and can be resent from the panel.
    let emailed = false;
    try {
      await sendInviteEmail(contato, formatDatetimeBrasiliaDisplay);
      emailed = true;
      await store.withDb((db) => { if (db.contatos[contato.id]) db.contatos[contato.id].emailSentAt = new Date().toISOString(); });
    } catch (err) {
      console.error(`Erro ao enviar e-mail do convite ${contato.id}:`, err.message);
    }
    return res.json({ ok: true, emailed });
  });

  // ---- admin
  app.get('/admin/contatos', requireAdminAuth, (req, res) => {
    const db = store.load();
    const list = Object.values(db.contatos || {})
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((c) => ({
        ...c,
        createdAtLabel: formatDatetimeBrasiliaDisplay(c.createdAt),
        whenLabel: c.dataIndefinida ? 'Data a definir' : dateBR(c.data),
        waLink: `https://wa.me/55${c.whatsapp}?text=${encodeURIComponent(`Oi ${c.nome}! Aqui é da Crewolada. Recebemos o seu convite e queremos conversar. 🙌`)}`,
        details: describe(c, formatDatetimeBrasiliaDisplay),
      }));
    res.render('admin_contatos', { eventInfo, list, inbox: INBOX(), msg: req.query.msg || null });
  });

  app.post('/admin/contatos/:id/status', requireAdminAuth, async (req, res) => {
    const status = ['novo', 'em-conversa', 'fechado', 'descartado'].includes(req.body.status) ? req.body.status : 'novo';
    await store.withDb((db) => { if (db.contatos && db.contatos[req.params.id]) db.contatos[req.params.id].status = status; });
    res.redirect('/admin/contatos');
  });

  app.post('/admin/contatos/:id/reenviar', requireAdminAuth, async (req, res) => {
    const c = (store.load().contatos || {})[req.params.id];
    if (!c) return res.redirect('/admin/contatos');
    try {
      await sendInviteEmail(c, formatDatetimeBrasiliaDisplay);
      await store.withDb((db) => { if (db.contatos[c.id]) db.contatos[c.id].emailSentAt = new Date().toISOString(); });
      return res.redirect('/admin/contatos?msg=reenviado');
    } catch (err) {
      console.error(`Erro ao reenviar convite ${c.id}:`, err.message);
      return res.redirect('/admin/contatos?msg=falhou');
    }
  });

  app.post('/admin/contatos/:id/excluir', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => { if (db.contatos) delete db.contatos[req.params.id]; });
    res.redirect('/admin/contatos');
  });

  app.get('/admin/contatos/exportar.csv', requireAdminAuth, (req, res) => {
    const list = Object.values(store.load().contatos || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const head = ['Recebido em', 'Status', 'Nome', 'Papel', 'WhatsApp', 'E-mail', 'Instagram', 'Quem convidar', 'Tipo de evento', 'Data', 'Cidade', 'UF', 'Local',
      'Início', 'Duração', 'Ingressos', 'Público', 'Som e luz', 'Precisa estrutura', 'Orçamento', 'Valor', 'Deslocamento', 'Detalhes'];
    const lines = [head.map(csvCell).join(';')];
    list.forEach((c) => lines.push([
      formatDatetimeBrasiliaDisplay(c.createdAt), c.status, c.nome, c.papel, c.whatsapp, c.email, c.instagram, c.convidar, c.tipoEvento,
      c.dataIndefinida ? 'a definir' : c.data, c.cidade, c.uf, c.local, c.inicio, c.duracao, c.bilhetado, c.publico, c.estrutura,
      c.precisaEstrutura, c.orcamento, c.orcamentoValor, c.deslocamento, c.detalhes,
    ].map(csvCell).join(';')));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="convites-crewolada.csv"');
    res.send('﻿' + lines.join('\r\n'));
  });
}

module.exports = { registerContatoRoutes, validate, OPCOES, ESTRUTURA_COMPLETA };
