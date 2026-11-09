const store = require('./store');
const { EVENTS, orderEventId, getEventById } = require('./event');
const { notifyMusicaEmail } = require('./n8n');

// ---------------------------------------------------------------------------
// Cancelamento de evento (aba Eventos do admin):
//  1) o admin cancela o evento informando o motivo -> as vendas/inscricoes param e os ingressos
//     deixam de valer na entrada;
//  2) numa segunda etapa, o admin dispara o e-mail para todos que compraram/se inscreveram,
//     informando o cancelamento, o motivo e o reembolso em ate 7 dias corridos.
// Os reembolsos em si seguem o fluxo de sempre (cancelar pedido + reembolsar, no painel de vendas).
// ---------------------------------------------------------------------------
const PRAZO_REEMBOLSO = '7 dias corridos';
const money = (n) => 'R$ ' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2).replace('.', ',');
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isGratuito = (o) => o.isCourtesy || o.isFree || o.productId === 'gratuito';

// Orders that must hear about it: confirmed (paid) ones. Pending/rejected never became tickets and
// cancelled ones were already refunded one by one.
function destinatarios(db, eventId) {
  const grupos = new Map();
  Object.values(db.orders || {}).forEach((o) => {
    if (orderEventId(o) !== eventId || o.status !== 'paid' || o.loteName === 'Lote Teste') return;
    const email = String(o.buyerEmail || '').trim().toLowerCase();
    if (!email) return;
    const g = grupos.get(email) || { email, nome: o.buyerName || '', pedidos: [], pago: 0 };
    g.nome = o.buyerName || g.nome;
    g.pedidos.push(o.id);
    if (!isGratuito(o)) g.pago += Number(o.totalAmount) || 0;
    g.enviado = (g.enviado === undefined ? true : g.enviado) && Boolean(o.cancelEmailSentAt);
    grupos.set(email, g);
  });
  return [...grupos.values()].map((g) => ({ ...g, pago: Math.round(g.pago * 100) / 100 })).sort((a, b) => a.nome.localeCompare(b.nome));
}

function montarEmail(ev, g, extra) {
  const nome = esc(String(g.nome || '').trim().split(' ')[0] || 'tudo bem');
  const motivo = esc(ev.cancelReason || '');
  const linhas = [
    `Olá, ${nome}.`,
    '',
    `Infelizmente precisamos avisar que o evento ${esc(ev.name)} (${esc(ev.dateLabel)}${ev.venue ? ', ' + esc(ev.venue) : ''}) foi cancelado.`,
    '',
    `Motivo: ${motivo}`,
    '',
  ];
  if (g.pago > 0) {
    linhas.push(`Sobre o seu ingresso: o valor pago (${money(g.pago)}) será reembolsado integralmente, sem nenhum desconto, em até ${PRAZO_REEMBOLSO} a partir deste aviso, no mesmo meio de pagamento usado na compra (Pix ou cartão). Você não precisa fazer nada. Em cartão, o estorno pode aparecer na fatura em até duas faturas, conforme a operadora.`);
  } else {
    linhas.push('Sua inscrição gratuita deixa de ter validade e não há nenhum valor a reembolsar.');
  }
  linhas.push('', 'O ingresso deste evento deixa de valer para entrada.');
  if (extra) linhas.push('', esc(extra));
  linhas.push('', 'Qualquer dúvida, é só responder este e-mail ou chamar a gente no WhatsApp (21) 3955-7816.', '', 'Pedimos desculpas pelo transtorno.', 'Equipe Crewolada');
  return { assunto: `Evento cancelado: ${ev.name} (${ev.dateLabel})`, mensagem: linhas.join('\n') };
}

// Progress of the running dispatch is kept in memory (the flags that matter are saved per order).
const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dispararEmails(ev, extra) {
  const db = store.load();
  const pendentes = destinatarios(db, ev.id).filter((g) => !g.enviado);
  const job = { estado: 'enviando', total: pendentes.length, enviados: 0, falhas: 0, erros: [], iniciadoEm: Date.now() };
  jobs.set(ev.id, job);

  let lote = [];
  const gravar = async () => {
    if (!lote.length) return;
    const ids = lote; lote = [];
    const em = new Date().toISOString();
    await store.withDb((d) => { ids.forEach((id) => { if (d.orders[id]) d.orders[id].cancelEmailSentAt = em; }); });
  };

  for (const g of pendentes) {
    try {
      const m = montarEmail(ev, g, extra);
      await notifyMusicaEmail({ email: g.email, nome: g.nome, assunto: m.assunto, mensagem: m.mensagem });
      job.enviados += 1;
      lote.push(...g.pedidos);
    } catch (err) {
      job.falhas += 1;
      if (job.erros.length < 5) job.erros.push(`${g.email}: ${err.message}`);
    }
    if (lote.length >= 25) await gravar();
    await sleep(150);
  }
  await gravar();
  job.estado = 'concluido';
  job.terminouEm = Date.now();
  await store.withDb((d) => {
    d.events = d.events || {};
    d.events[ev.id] = { ...(d.events[ev.id] || {}), id: ev.id, cancelEmail: { em: new Date().toISOString(), enviados: job.enviados, falhas: job.falhas } };
  });
}

function registerCancelamentoRoutes(app, { requireAdminAuth, eventInfo, onChange, formatDatetimeBrasiliaDisplay }) {
  const achar = (id) => EVENTS.find((e) => e.id === id);

  app.post('/admin/eventos/:id/cancelar', requireAdminAuth, async (req, res) => {
    const ev = achar(req.params.id);
    if (!ev) return res.redirect('/admin/eventos?msg=dados');
    if (ev.cancelledAt) return res.redirect(`/admin/eventos/${encodeURIComponent(ev.id)}/cancelamento`);
    const motivo = String(req.body.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (motivo.length < 10 || req.body.confirmo !== 'on') return res.redirect('/admin/eventos?msg=cancelar-dados');
    await store.withDb((db) => {
      db.events = db.events || {};
      db.events[ev.id] = { ...(db.events[ev.id] || {}), id: ev.id, cancelledAt: new Date().toISOString(), cancelReason: motivo };
    });
    onChange();
    console.log(`[evento] cancelado: ${ev.id} (${motivo})`);
    res.redirect(`/admin/eventos/${encodeURIComponent(ev.id)}/cancelamento?novo=1`);
  });

  // Undo, only while nobody was told yet.
  app.post('/admin/eventos/:id/reativar', requireAdminAuth, async (req, res) => {
    const ev = achar(req.params.id);
    if (!ev || !ev.cancelledAt) return res.redirect('/admin/eventos?msg=dados');
    const db = store.load();
    const avisados = Object.values(db.orders || {}).some((o) => orderEventId(o) === ev.id && o.cancelEmailSentAt);
    const rodando = jobs.get(ev.id) && jobs.get(ev.id).estado === 'enviando';
    if (avisados || rodando) return res.redirect('/admin/eventos?msg=nao-pode-reativar');
    await store.withDb((d) => {
      const e = (d.events || {})[ev.id];
      if (e) { e.cancelledAt = null; e.cancelReason = null; }
    });
    onChange();
    res.redirect('/admin/eventos?msg=reativado');
  });

  app.get('/admin/eventos/:id/cancelamento', requireAdminAuth, (req, res) => {
    const ev = achar(req.params.id);
    if (!ev || !ev.cancelledAt) return res.redirect('/admin/eventos');
    const db = store.load();
    const dest = destinatarios(db, ev.id);
    const aReembolsar = Object.values(db.orders || {}).filter((o) => orderEventId(o) === ev.id && o.status === 'paid' && !isGratuito(o) && o.loteName !== 'Lote Teste');
    const exemplo = dest[0] ? montarEmail(ev, dest.find((d) => d.pago > 0) || dest[0], '') : null;
    res.render('admin_evento_cancelamento', {
      eventInfo, ev, novo: req.query.novo === '1', money,
      canceladoEm: formatDatetimeBrasiliaDisplay(ev.cancelledAt),
      dest, total: dest.length, enviados: dest.filter((d) => d.enviado).length,
      aReembolsar: aReembolsar.length, valorReembolsar: aReembolsar.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0),
      exemplo, prazo: PRAZO_REEMBOLSO, job: jobs.get(ev.id) || null,
    });
  });

  app.post('/admin/eventos/:id/cancelamento/enviar', requireAdminAuth, (req, res) => {
    const ev = achar(req.params.id);
    if (!ev || !ev.cancelledAt) return res.redirect('/admin/eventos');
    const atual = jobs.get(ev.id);
    if (atual && atual.estado === 'enviando') return res.redirect(`/admin/eventos/${encodeURIComponent(ev.id)}/cancelamento`);
    const extra = String(req.body.extra || '').replace(/\r/g, '').trim().slice(0, 600);
    dispararEmails(ev, extra).catch((err) => { console.error('Falha no disparo de cancelamento:', err.message); const j = jobs.get(ev.id); if (j) j.estado = 'concluido'; });
    res.redirect(`/admin/eventos/${encodeURIComponent(ev.id)}/cancelamento`);
  });

  app.get('/api/admin/eventos/:id/cancelamento/progresso', requireAdminAuth, (req, res) => {
    const j = jobs.get(req.params.id);
    res.json(j ? { estado: j.estado, total: j.total, enviados: j.enviados, falhas: j.falhas, erros: j.erros } : { estado: 'parado' });
  });
}

module.exports = { registerCancelamentoRoutes, destinatarios, montarEmail };
