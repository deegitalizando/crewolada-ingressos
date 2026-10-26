const store = require('./store');
const { EVENTS, orderEventId, getEventById } = require('./event');
const { normalizePhone } = require('./n8n');

// ---------------------------------------------------------------------------
// Lead export (CSV for Excel / Google Sheets): the people who registered for tickets.
//   tipo=contatos      one row per person (deduplicated by CPF, e-mail or phone)
//   tipo=pedidos       one row per order
//   tipo=participantes one row per ticket (guest list, with who attends when informed)
//   quais=pagos | gratuitos (courtesy + free registration) | pendentes | cancelados | todos
//   evento=<event id> | todos
// ---------------------------------------------------------------------------
const STATUS = { paid: 'Pago', pending: 'Pendente', rejected: 'Recusado', cancelled: 'Cancelado' };
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => round2(n).toFixed(2).replace('.', ',');
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

// Names and e-mails come from a public form: a cell that starts with = + - @ would run as a
// formula in Excel, so those are prefixed with an apostrophe. `trusted` cells are built by us.
function cell(v, trusted = false) {
  let s = String(v == null ? '' : v);
  if (!trusted && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const line = (arr) => arr.map((v) => (v && v.trusted ? cell(v.v, true) : cell(v))).join(';');
const trusted = (v) => ({ trusted: true, v });

const fmtCpf = (c) => { const d = onlyDigits(c); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d; };
// +55 21 98888-7777 (text, so Excel does not turn it into a number)
function fmtPhone(p) {
  const d = onlyDigits(p);
  if (!d) return '';
  const n = normalizePhone(d);
  const m = n.match(/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+${m[1]} ${m[2]} ${m[3]}-${m[4]}` : `+${n}`;
}

function tipoDoPedido(o) {
  if (o.isCourtesy) return 'Cortesia';
  if (o.isFree || o.productId === 'gratuito') return 'Inscrição gratuita';
  return 'Venda';
}
const isGratuito = (o) => o.isCourtesy || o.isFree || o.productId === 'gratuito';

function selecionar(db, { evento, quais }) {
  return Object.values(db.orders || {}).filter((o) => {
    if (o.loteName === 'Lote Teste') return false; // test sales are never leads
    if (evento && evento !== 'todos' && orderEventId(o) !== evento) return false;
    switch (quais) {
      case 'gratuitos': return isGratuito(o) && o.status === 'paid';
      case 'pendentes': return o.status === 'pending';
      case 'cancelados': return o.status === 'cancelled';
      case 'todos': return true;
      default: return o.status === 'paid' && !isGratuito(o); // pagos
    }
  });
}

function detalhes(o) {
  if (Array.isArray(o.items) && o.items.length) {
    return o.items.filter((i) => i.qty > 0).map((i) => `${i.qty}x ${i.label || i.kind}`).join(', ');
  }
  return `${o.quantity || 1}x`;
}

function montar(db, { tipo, evento, quais }, fmtDate) {
  const pedidos = selecionar(db, { evento, quais }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const ticketsDe = {};
  Object.values(db.tickets || {}).forEach((t) => { (ticketsDe[t.orderId] = ticketsDe[t.orderId] || []).push(t); });
  const nomeEvento = (o) => getEventById(orderEventId(o)).name;

  if (tipo === 'participantes') {
    const rows = [['Ingresso', 'Evento', 'Pedido', 'Tipo do ingresso', 'Situação', 'Entrou em', 'Participante', 'E-mail do participante', 'WhatsApp do participante', 'Comprador', 'E-mail do comprador', 'WhatsApp do comprador', 'CPF do comprador']];
    pedidos.forEach((o) => {
      (ticketsDe[o.id] || []).forEach((t) => {
        rows.push([
          t.code, nomeEvento(o), o.id.slice(0, 8), t.kindLabel || o.loteName || '', t.status === 'used' ? 'Usado' : 'Válido', t.usedAt ? fmtDate(t.usedAt) : '',
          t.participantName || o.buyerName || '', t.participantEmail || o.buyerEmail || '', trusted(fmtPhone(t.participantPhone || o.buyerPhone)),
          o.buyerName || '', o.buyerEmail || '', trusted(fmtPhone(o.buyerPhone)), trusted(fmtCpf(o.buyerCpf)),
        ]);
      });
    });
    return rows;
  }

  if (tipo === 'pedidos') {
    const rows = [['Data', 'Evento', 'Tipo', 'Situação', 'Pedido', 'Nome', 'E-mail', 'WhatsApp', 'CPF', 'Produto', 'Quantidade', 'Detalhes', 'Valor (R$)', 'Pagamento', 'Ingressos', 'Entraram']];
    [...pedidos].reverse().forEach((o) => {
      const ts = ticketsDe[o.id] || [];
      rows.push([
        trusted(fmtDate(o.createdAt)), nomeEvento(o), tipoDoPedido(o), STATUS[o.status] || o.status, o.id.slice(0, 8), o.buyerName || '', o.buyerEmail || '',
        trusted(fmtPhone(o.buyerPhone)), trusted(fmtCpf(o.buyerCpf)), o.loteName || '', o.quantity || 0, detalhes(o), trusted(money(o.totalAmount)),
        o.paymentMethodId || '', ts.map((t) => t.code).join(' '), ts.length ? `${ts.filter((t) => t.status === 'used').length}/${ts.length}` : '',
      ]);
    });
    return rows;
  }

  // contatos: one row per person
  const pessoas = new Map();
  pedidos.forEach((o) => {
    const cpf = onlyDigits(o.buyerCpf);
    const email = String(o.buyerEmail || '').trim().toLowerCase();
    const fone = onlyDigits(o.buyerPhone);
    const chave = cpf || email || fone || o.id;
    const p = pessoas.get(chave) || { nome: '', email: '', fone: '', cpf: '', pedidos: 0, ingressos: 0, valor: 0, eventos: new Set(), origens: new Set(), primeira: o.createdAt, ultima: o.createdAt };
    p.nome = o.buyerName || p.nome; p.email = o.buyerEmail || p.email; p.fone = o.buyerPhone || p.fone; p.cpf = o.buyerCpf || p.cpf; // latest wins
    p.pedidos += 1;
    p.ingressos += Number(o.quantity) || 0;
    if (o.status === 'paid' && !isGratuito(o)) p.valor += Number(o.totalAmount) || 0;
    p.eventos.add(nomeEvento(o));
    p.origens.add(tipoDoPedido(o));
    if (String(o.createdAt) < String(p.primeira)) p.primeira = o.createdAt;
    if (String(o.createdAt) > String(p.ultima)) p.ultima = o.createdAt;
    pessoas.set(chave, p);
  });
  const rows = [['Nome', 'E-mail', 'WhatsApp', 'CPF', 'Pedidos', 'Ingressos', 'Valor pago (R$)', 'Eventos', 'Origem', 'Primeira compra', 'Última compra']];
  [...pessoas.values()].sort((a, b) => String(b.ultima).localeCompare(String(a.ultima))).forEach((p) => {
    rows.push([p.nome, p.email, trusted(fmtPhone(p.fone)), trusted(fmtCpf(p.cpf)), p.pedidos, p.ingressos, trusted(money(p.valor)), [...p.eventos].join(' | '), [...p.origens].join(' | '), trusted(fmtDate(p.primeira)), trusted(fmtDate(p.ultima))]);
  });
  return rows;
}

function registerLeadsRoutes(app, { requireAdminAuth, formatDatetimeBrasiliaDisplay }) {
  app.get('/admin/leads/exportar.csv', requireAdminAuth, (req, res) => {
    const tipo = ['contatos', 'pedidos', 'participantes'].includes(req.query.tipo) ? req.query.tipo : 'contatos';
    const quais = ['pagos', 'gratuitos', 'pendentes', 'cancelados', 'todos'].includes(req.query.quais) ? req.query.quais : 'pagos';
    const evento = EVENTS.some((e) => e.id === req.query.evento) ? req.query.evento : 'todos';
    const rows = montar(store.load(), { tipo, evento, quais }, formatDatetimeBrasiliaDisplay);

    const slug = evento === 'todos' ? 'todos-eventos' : evento;
    const dia = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
    console.log(`[leads] exportacao ${tipo}/${quais}/${evento}: ${rows.length - 1} linhas`);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="leads-${slug}-${tipo}-${quais}-${dia}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send('﻿' + rows.map(line).join('\r\n'));
  });
}

module.exports = { registerLeadsRoutes, montar, selecionar };
