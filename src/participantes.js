// Regra "1 ingresso por pessoa": cada ingresso de um evento pertence a uma
// pessoa diferente, identificada pelo CPF.
//
// - O ingresso 1 de todo pedido é do comprador (CPF do comprador).
// - Os ingressos 2, 3... só existem com o participante informado na hora da
//   compra/inscrição: nome + CPF (adulto). Criança/bebê não têm CPF
//   obrigatório, só o nome.
// - Um CPF só pode aparecer uma vez por evento, somando todos os pedidos —
//   como comprador ou como participante de outra pessoa.
const { isValidCpf } = require('./cpf');
const { inEvent } = require('./event');

const digits = (s) => String(s || '').replace(/\D/g, '');
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const normName = (s) => cleanName(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function cleanPhone(raw) {
  let p = digits(raw).replace(/^0+/, '');
  if (p.length > 11 && p.startsWith('55')) p = p.slice(2);
  return p;
}

// Lê os participantes dos ingressos 2..n do corpo da requisição. Aceita tanto
// array (JSON do checkout) quanto objeto indexado (formulário HTML).
function readParticipants(body, count) {
  const raw = body && body.participantes;
  const list = Array.isArray(raw) ? raw : Object.keys(raw || {}).sort((a, b) => a - b).map((k) => raw[k]);
  const out = [];
  for (let i = 0; i < Math.max(0, count - 1); i += 1) {
    const p = list[i] || {};
    out.push({
      name: cleanName(p.name || p.nome),
      cpf: digits(p.cpf),
      email: String(p.email || '').trim().toLowerCase().slice(0, 120),
      phone: cleanPhone(p.phone || p.whatsapp),
    });
  }
  return out;
}

// CPF já usado por algum ingresso do evento → nome de quem o usa.
// statuses: quais pedidos contam (inscrição gratuita conta 'pending' também,
// porque vira paga na mesma requisição; compra paga só conta 'paid', para um
// Pix abandonado não travar a pessoa de comprar de novo).
function cpfsTakenInEvent(db, eventId, { statuses = ['paid'], excludeOrderId = null } = {}) {
  const taken = new Map();
  const orders = db.orders || {};
  const ticketsByOrder = {};
  Object.values(db.tickets || {}).forEach((t) => {
    (ticketsByOrder[t.orderId] = ticketsByOrder[t.orderId] || []).push(t);
  });
  Object.values(orders).forEach((o) => {
    if (o.id === excludeOrderId || !statuses.includes(o.status) || !inEvent(o, eventId)) return;
    const tickets = (ticketsByOrder[o.id] || []).slice().sort((a, b) => (a.drawNumber || 0) - (b.drawNumber || 0));
    const add = (cpf, name) => { if (cpf && !taken.has(cpf)) taken.set(cpf, name || ''); };
    if (tickets.length) {
      tickets.forEach((t, i) => {
        if (t.status === 'cancelled') return;
        add(digits(t.participantCpf) || (i === 0 ? digits(o.buyerCpf) : ''), t.participantName || (i === 0 ? o.buyerName : ''));
      });
    } else {
      add(digits(o.buyerCpf), o.buyerName);
      (o.participants || []).forEach((p) => add(digits(p.cpf), p.name));
    }
  });
  return taken;
}

const firstName = (s) => cleanName(s).split(' ')[0] || 'outra pessoa';

// Valida comprador + participantes de um pedido novo. kinds[i] é a categoria
// do ingresso i (adulto/crianca/bebe) quando a compra tem categorias.
// Retorna uma mensagem de erro ou null.
function validateNewOrder({ buyerName, buyerCpf, participants, kinds = [], taken }) {
  const buyer = digits(buyerCpf);
  if (taken.has(buyer)) {
    return 'Este CPF já tem um ingresso para este evento. Cada pessoa pode ter só 1 ingresso. Para ver ou editar o seu, acesse Meus ingressos.';
  }
  const seenCpf = new Set([buyer]);
  const seenName = new Set([normName(buyerName)]);
  for (let i = 0; i < participants.length; i += 1) {
    const p = participants[i];
    const n = i + 2;
    const kind = kinds[i + 1] || 'adulto';
    const needsCpf = kind === 'adulto';
    if (p.name.split(' ').length < 2) return `Ingresso ${n}: informe o nome completo de quem vai usar.`;
    if (seenName.has(normName(p.name))) {
      return `Ingresso ${n}: o nome repete outro ingresso. Cada ingresso é de uma pessoa diferente — informe o nome de quem vai usar.`;
    }
    seenName.add(normName(p.name));
    if (needsCpf && !p.cpf) return `Ingresso ${n}: informe o CPF de ${firstName(p.name)}.`;
    if (p.cpf) {
      if (!isValidCpf(p.cpf)) return `Ingresso ${n}: o CPF de ${firstName(p.name)} é inválido.`;
      if (seenCpf.has(p.cpf)) return `Ingresso ${n}: o CPF repete outro ingresso. Cada pessoa pode ter só 1 ingresso.`;
      if (taken.has(p.cpf)) return `Ingresso ${n}: ${firstName(p.name)} já tem ingresso para este evento. Cada pessoa pode ter só 1 ingresso.`;
      seenCpf.add(p.cpf);
    }
    if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return `Ingresso ${n}: o e-mail de ${firstName(p.name)} é inválido.`;
    if (p.phone && !/^[1-9][1-9]\d{8,9}$/.test(p.phone)) return `Ingresso ${n}: o WhatsApp de ${firstName(p.name)} é inválido (use DDD + número).`;
  }
  return null;
}

module.exports = {
  readParticipants, cpfsTakenInEvent, validateNewOrder, digits, cleanName, normName, cleanPhone, firstName,
};
