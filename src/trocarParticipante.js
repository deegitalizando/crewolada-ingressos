const crypto = require('crypto');
const QRCode = require('qrcode');
const store = require('./store');
const { EVENTS, orderEventId, getEventById } = require('./event');
const R = require('./participantes');
const { isValidCpf } = require('./cpf');
const { generateTicketCode } = require('./tickets');
const { notifyMusicaEmail } = require('./n8n');

// ---------------------------------------------------------------------------
// Trocar quem vai usar um ingresso (a pessoa desistiu e indicou outra).
//  - o ingresso antigo e cancelado e nasce um novo, com outro codigo/QR e o mesmo numero do sorteio,
//    entao o PDF que a pessoa anterior guardou deixa de abrir a entrada;
//  - se era o ingresso do comprador (ingresso 1), o pedido passa a ser da pessoa nova;
//  - as regras do cadastro continuam: CPF valido, CPF/e-mail/WhatsApp ainda sem ingresso no evento;
//  - ingresso ja escaneado na portaria nao pode ser trocado.
// Dois caminhos usam o mesmo motor: o painel admin (/admin/trocar-participante) e o proprio cliente
// (/ingresso/<codigo>/trocar, depois de confirmar os dados do pedido).
// ---------------------------------------------------------------------------
const MAX_TROCAS_CLIENTE = 3; // por pedido; alem disso, so pela equipe
const locked = (t) => t.status === 'used' || t.status === 'cancelled' || Boolean(t.usedAt);
const ordenar = (a, b) => (a.drawNumber || 0) - (b.drawNumber || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
const liveTickets = (db, orderId) => Object.values(db.tickets || {}).filter((t) => t.orderId === orderId && t.status !== 'cancelled').sort(ordenar);
const maskCpf = (c) => { const d = R.digits(c); return d.length === 11 ? `***.***.${d.slice(6, 9)}-${d.slice(9)}` : (d ? '***' : '-'); };
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function holderOf(order, t, i) {
  return {
    name: t.participantName || (i === 0 ? order.buyerName : '') || '',
    cpf: t.participantCpf || (i === 0 ? order.buyerCpf : '') || '',
    email: t.participantEmail || (i === 0 ? order.buyerEmail : '') || '',
    phone: t.participantPhone || (i === 0 ? order.buyerPhone : '') || '',
  };
}

// Is this the buyer's own ticket (so the order itself changes hands)?
const isBuyerTicket = (order, t, i) => i === 0 && (!t.participantName || R.normName(t.participantName) === R.normName(order.buyerName));

function buscar(db, eventId, termo) {
  const q = R.normName(termo);
  const qd = R.digits(termo);
  const qmail = String(termo || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  Object.values(db.orders || {}).forEach((o) => {
    if (o.status !== 'paid' || orderEventId(o) !== eventId) return;
    liveTickets(db, o.id).forEach((t, i) => {
      const h = holderOf(o, t, i);
      const acha = R.normName(h.name).includes(q)
        || String(h.email).toLowerCase().includes(qmail)
        || (qd.length >= 4 && (R.digits(h.cpf).includes(qd) || R.digits(h.phone).includes(qd)));
      if (!acha) return;
      out.push({
        code: t.code, orderId: o.id, titular: isBuyerTicket(o, t, i), trancado: locked(t),
        nome: h.name, cpf: maskCpf(h.cpf), email: h.email, phone: h.phone,
        pedidoComMais: liveTickets(db, o.id).length > 1,
      });
    });
  });
  return out.slice(0, 30);
}

// The swap itself. Returns { erro } or { ok: true, ... }.
function criarTroca({ eventInfoFor, notifyOrderApproved, buildTicketPdf }) {
  return async function trocar({ code, eventoId = null, novo: raw, reenviar = false, avisarAnterior = false, origem = 'admin' }) {
    const db = store.load();
    const antigo = (db.tickets || {})[String(code || '')];
    const order = antigo && db.orders[antigo.orderId];
    if (!antigo || !order || order.status !== 'paid' || (eventoId && orderEventId(order) !== eventoId)) return { erro: 'Ingresso não encontrado neste evento.' };
    const evId = orderEventId(order);
    if (locked(antigo)) return { erro: 'Este ingresso já foi usado na entrada (ou está cancelado) e não pode ser trocado.' };

    const novo = {
      name: R.cleanName(raw.nome),
      cpf: R.digits(raw.cpf),
      email: String(raw.email || '').trim().toLowerCase().slice(0, 120),
      phone: R.cleanPhone(raw.whatsapp),
    };
    if (novo.name.split(' ').length < 2) return { erro: 'Informe o nome completo da pessoa nova.' };
    if (!isValidCpf(novo.cpf)) return { erro: 'O CPF informado é inválido.' };
    const cErr = R.contactError(novo, 1);
    if (cErr) return { erro: cErr.replace('Ingresso 1: ', '') };

    const vivos = liveTickets(db, order.id);
    const idx = vivos.findIndex((t) => t.code === antigo.code);
    const compradorMuda = isBuyerTicket(order, antigo, idx);

    // Uniqueness is checked as if the current holder were already gone.
    const tmp = { orders: { ...db.orders }, tickets: { ...db.tickets } };
    delete tmp.tickets[antigo.code];
    if (compradorMuda) tmp.orders[order.id] = { ...order, buyerName: '', buyerCpf: '', buyerEmail: '', buyerPhone: '' };
    const taken = R.cpfsTakenInEvent(tmp, evId);
    const contatos = R.contactsTakenInEvent(tmp, evId);
    if (taken.has(novo.cpf)) return { erro: 'Esta pessoa já tem ingresso neste evento (o CPF já está em outro ingresso). Cada pessoa pode ter só 1 ingresso.' };
    if (contatos.emails.has(novo.email)) return { erro: 'Este e-mail já tem ingresso neste evento. Informe o e-mail da própria pessoa.' };
    if (contatos.phones.has(novo.phone)) return { erro: 'Este WhatsApp já tem ingresso neste evento. Informe o WhatsApp da própria pessoa.' };

    const codigo = generateTicketCode();
    const qrCodeDataUrl = await QRCode.toDataURL(codigo, { margin: 1, width: 320 });
    const agora = new Date().toISOString();
    const anterior = holderOf(order, antigo, idx);

    let falhou = null;
    await store.withDb((d) => {
      const velho = d.tickets[antigo.code];
      const ped = d.orders[order.id];
      if (!velho || locked(velho)) { falhou = 'O ingresso mudou enquanto você trocava (foi usado ou cancelado). Nada foi alterado.'; return; }
      d.tickets[codigo] = {
        ...velho,
        id: crypto.randomUUID(),
        code: codigo,
        qrCodeDataUrl,
        qrCodeBase64: qrCodeDataUrl.replace(/^data:image\/png;base64,/, ''),
        status: 'valid',
        usedAt: null,
        pdfBase64: null,
        participantName: novo.name,
        participantCpf: novo.cpf,
        participantEmail: novo.email,
        participantPhone: novo.phone,
        createdAt: agora,
        trocaDe: { codigo: velho.code, nome: anterior.name, cpf: anterior.cpf, email: anterior.email, phone: anterior.phone, em: agora, origem },
      };
      velho.status = 'cancelled';
      velho.cancelledAt = agora;
      velho.cancelReason = origem === 'cliente' ? 'Participante trocado pelo cliente' : 'Participante trocado pelo admin';
      velho.replacedBy = codigo;
      velho.drawNumber = null; // the number moved to the new ticket
      delete velho.pdfBase64;
      if (compradorMuda) {
        ped.buyerName = novo.name; ped.buyerCpf = novo.cpf; ped.buyerEmail = novo.email; ped.buyerPhone = novo.phone;
      }
      ped.trocasParticipante = [...(ped.trocasParticipante || []), { em: agora, de: anterior.name, para: novo.name, codigoAntigo: velho.code, codigoNovo: codigo, origem }];
    });
    if (falhou) return { erro: falhou };

    // New PDF for the new ticket (it is what the resends attach).
    const fresh = store.load();
    const pedido = fresh.orders[order.id];
    try {
      const pdf = await buildTicketPdf({ eventInfo: eventInfoFor(pedido), order: pedido, ticket: fresh.tickets[codigo] });
      await store.withDb((d) => { if (d.tickets[codigo]) d.tickets[codigo].pdfBase64 = pdf.toString('base64'); });
    } catch (err) {
      console.error('Erro ao gerar PDF do ingresso trocado:', err.message);
    }

    let reenvio = 'nao';
    if (reenviar) {
      try {
        const f2 = store.load();
        await notifyOrderApproved(f2.orders[order.id], [f2.tickets[codigo]], { origin: 'reenvio', to: { nome: novo.name, whatsapp: novo.phone, email: novo.email } });
        reenvio = 'sim';
      } catch (err) {
        console.error('Erro ao reenviar ingresso trocado:', err.message);
        reenvio = 'falha';
      }
    }

    // Whoever lost the ticket (and the order's owner, if someone else) is told it moved.
    if (avisarAnterior) {
      const ev = getEventById(evId);
      const destinos = new Map();
      [anterior, { name: order.buyerName, email: order.buyerEmail }].forEach((p) => {
        const em = String(p.email || '').trim().toLowerCase();
        if (em && em !== novo.email && !destinos.has(em)) destinos.set(em, p.name);
      });
      for (const [em, nome] of destinos) {
        try {
          await notifyMusicaEmail({
            email: em,
            nome,
            assunto: `Seu ingresso da ${ev.name} foi passado para outra pessoa`,
            mensagem: [
              `Olá, ${esc(String(nome || '').split(' ')[0] || 'tudo bem')}.`,
              '',
              `O ingresso da ${esc(ev.name)} (${esc(ev.dateLabel)}) que estava no nome de ${esc(anterior.name)} foi passado para ${esc(novo.name)}.`,
              'O QR Code antigo deixou de valer na entrada; só o ingresso novo abre a porta.',
              '',
              'Se você não reconhece essa troca, responda este e-mail ou escreva para contato@crewolada.com agora mesmo.',
              '',
              'Equipe Crewolada',
            ].join('\n'),
          });
        } catch (err) {
          console.error('Erro ao avisar sobre a troca de ingresso:', err.message);
        }
      }
    }

    console.log(`[troca:${origem}] ingresso ${antigo.code} -> ${codigo} (${anterior.name} -> ${novo.name}) evento ${evId}`);
    return { ok: true, anterior, novo, codigoNovo: codigo, reenvio, orderId: order.id };
  };
}

function registerTrocarParticipanteRoutes(app, deps) {
  const { requireAdminAuth, eventInfo, eventInfoFor } = deps;
  const trocar = criarTroca(deps);

  // ---- admin ---------------------------------------------------------------
  const volta = (eventoId, busca, extra) => `/admin/trocar-participante?evento=${encodeURIComponent(eventoId)}&busca=${encodeURIComponent(busca || '')}&${extra}`;

  app.get('/admin/trocar-participante', requireAdminAuth, (req, res) => {
    const db = store.load();
    const eventoId = EVENTS.some((e) => e.id === req.query.evento) ? req.query.evento : (EVENTS.find((e) => e.free && e.slug) || EVENTS[0]).id;
    const busca = String(req.query.busca || '').trim().slice(0, 120);
    res.render('admin_trocar_participante', {
      eventInfo,
      eventos: EVENTS.map((e) => ({ id: e.id, name: e.name, dateLabel: e.dateLabel })),
      eventoId, busca,
      resultados: busca ? buscar(db, eventoId, busca) : null,
      ok: req.query.ok || null, erro: req.query.erro || null,
    });
  });

  app.post('/admin/trocar-participante', requireAdminAuth, async (req, res) => {
    const eventoId = String(req.body.evento || '');
    const busca = String(req.body.busca || '');
    const r = await trocar({ code: req.body.code, eventoId, novo: req.body, reenviar: req.body.reenviar === 'on', origem: 'admin' });
    if (r.erro) return res.redirect(volta(eventoId, busca, `erro=${encodeURIComponent(r.erro)}`));
    const msg = `Troca feita: ${r.anterior.name || 'participante anterior'} saiu e ${r.novo.name} entrou. Um ingresso novo foi gerado e o antigo foi cancelado.`
      + (r.reenvio === 'sim' ? ' O ingresso novo foi enviado por e-mail e WhatsApp.' : r.reenvio === 'falha' ? ' Atenção: o envio do ingresso falhou, reenvie pelo painel de Vendas.' : ' Ele não foi enviado: use o reenvio no painel de Vendas.');
    return res.redirect(volta(eventoId, busca, `ok=${encodeURIComponent(msg)}`));
  });

  // ---- the person themselves (from /meus-ingressos) ------------------------
  // Whoever owns the order confirms it with the order's CPF + e-mail or WhatsApp, then indicates the new person.
  const ipHits = new Map();
  const codeFails = new Map();
  const recente = (m, k, ms) => { const now = Date.now(); const l = (m.get(k) || []).filter((x) => now - x < ms); m.set(k, l); return l; };
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;

  const pagina = (res, status, ctx) => res.status(status).render('troca_ingresso', {
    eventInfo, ev: null, code: '', erro: null, done: null, values: {}, bloqueado: null, ...ctx,
  });

  // Why this ticket cannot be swapped by the customer, or null.
  function impedimento(db, t) {
    const order = t && db.orders[t.orderId];
    if (!t || !order || order.status !== 'paid') return 'Ingresso não encontrado.';
    const ev = eventInfoFor(order);
    if (ev.cancelledAt) return 'Este evento foi cancelado: não é possível trocar o ingresso.';
    const start = ev.startAt ? Date.parse(ev.startAt) : NaN;
    if (!Number.isNaN(start) && Date.now() > start) return 'O evento já começou: a troca não está mais disponível.';
    if (locked(t)) return t.status === 'cancelled' ? 'Este ingresso foi cancelado.' : 'Este ingresso já foi usado na entrada.';
    if (!R.digits(order.buyerCpf)) return 'Este pedido não tem CPF cadastrado para confirmar a troca. Fale com a organização.';
    if ((order.trocasParticipante || []).length >= MAX_TROCAS_CLIENTE) return 'Este pedido já teve trocas demais pelo site. Para mais uma, fale com a organização.';
    return null;
  }

  app.get('/ingresso/:code/trocar', (req, res) => {
    const db = store.load();
    const t = db.tickets[req.params.code];
    const bloqueado = impedimento(db, t);
    const order = t && db.orders[t.orderId];
    return pagina(res, bloqueado ? 400 : 200, { ev: order ? eventInfoFor(order) : null, code: req.params.code, bloqueado });
  });

  app.post('/ingresso/:code/trocar', async (req, res) => {
    const code = req.params.code;
    const db = store.load();
    const t = db.tickets[code];
    const order = t && db.orders[t.orderId];
    const ev = order ? eventInfoFor(order) : null;
    const values = { ...req.body };
    delete values.confirma_cpf;
    const falha = (status, erro) => pagina(res, status, { ev, code, erro, values });

    if (recente(ipHits, ipOf(req), 15 * 60000).length >= 30) return falha(429, 'Muitas tentativas em pouco tempo. Tente de novo mais tarde.');
    ipHits.get(ipOf(req)).push(Date.now());
    const bloqueado = impedimento(db, t);
    if (bloqueado) return pagina(res, 400, { ev, code, bloqueado });
    if (recente(codeFails, code, 3600000).length >= 5) return falha(429, 'Muitas confirmações erradas para este ingresso. Tente de novo em 1 hora ou fale com a organização.');

    // Confirmation of the order's owner: CPF + (e-mail or WhatsApp) as registered at purchase/sign-up.
    const cpfOk = R.digits(req.body.confirma_cpf) === R.digits(order.buyerCpf);
    const emailInformado = String(req.body.confirma_email || '').trim().toLowerCase();
    const telInformado = R.cleanPhone(req.body.confirma_whatsapp);
    const emailOk = Boolean(emailInformado) && emailInformado === String(order.buyerEmail || '').trim().toLowerCase();
    const telOk = telInformado.length >= 10 && telInformado.slice(-10) === R.cleanPhone(order.buyerPhone).slice(-10);
    if (!cpfOk || !(emailOk || telOk)) {
      codeFails.get(code).push(Date.now());
      return falha(400, 'Os dados de confirmação não conferem com os do pedido. Informe o CPF e o e-mail ou o WhatsApp usados na compra ou na inscrição.');
    }

    const r = await trocar({ code, novo: req.body, reenviar: true, avisarAnterior: true, origem: 'cliente' });
    if (r.erro) return falha(400, r.erro);
    return pagina(res, 200, { ev, code, done: { nome: r.novo.name, codigo: r.codigoNovo, reenvio: r.reenvio } });
  });
}

module.exports = { registerTrocarParticipanteRoutes, buscar, criarTroca };
