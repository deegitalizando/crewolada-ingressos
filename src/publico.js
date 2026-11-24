const { EVENTS, orderEventId, getEventById, currentEvent } = require('./event');
const { normalizePhone } = require('./n8n');

// ---------------------------------------------------------------------------
// Audience builder for the campaigns of /admin/mensagens: every lead the site
// has, filtered by where they came from and by event, minus who should be left
// out (e.g. who already has a ticket for the current event). One entry per
// person (same WhatsApp or same e-mail = same person).
// ---------------------------------------------------------------------------

const FONTES = {
  pagos: 'Compraram ingresso',
  gratuitos: 'Cortesias e inscrições gratuitas',
  participantes: 'Acompanhantes (nome no ingresso de outra pessoa)',
  pendentes: 'Começaram a compra e não pagaram',
  musica: 'Compraram música personalizada',
  sorteio: 'Participaram de sorteio',
  pesquisa: 'Responderam a pesquisa',
  contatos: 'Pediram a Crewolada para um evento (convites)',
};
const FONTES_DE_EVENTO = ['pagos', 'gratuitos', 'participantes', 'pendentes'];

const isGratuito = (o) => o.isCourtesy || o.isFree || o.productId === 'gratuito';
const digits = (v) => String(v || '').replace(/\D/g, '');
const phoneKey = (v) => { const d = digits(v); return d.length >= 10 ? normalizePhone(d) : ''; };
const emailKey = (v) => { const e = String(v || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : ''; };

// Events offered in the filter: every event that has orders, newest first.
function eventosComPedidos(db) {
  const usados = new Map();
  Object.values(db.orders || {}).forEach((o) => {
    if (o.loteName === 'Lote Teste') return;
    const id = orderEventId(o);
    usados.set(id, (usados.get(id) || 0) + 1);
  });
  return [...usados.keys()]
    .map((id) => ({ ...getEventById(id), pedidos: usados.get(id) }))
    .filter((e) => e && e.id)
    .sort((a, b) => String(b.startAt || '').localeCompare(String(a.startAt || '')))
    .map((e) => ({ id: e.id, name: e.name, dateLabel: e.dateLabel, pedidos: e.pedidos, atual: e.id === currentEvent.id }));
}

function normalizarFiltros(raw = {}) {
  const lista = (v) => [].concat(v || []).map(String).filter(Boolean);
  const fontes = lista(raw.fontes).filter((f) => FONTES[f]);
  return {
    fontes: fontes.length ? fontes : ['pagos', 'gratuitos'],
    eventos: lista(raw.eventos), // empty = every event
    excluirEventos: lista(raw.excluirEventos), // who has a ticket for these is left out
  };
}

function montarPublico(db, filtrosRaw) {
  const f = normalizarFiltros(filtrosRaw);
  const fontes = new Set(f.fontes);
  const eventoOk = (o) => !f.eventos.length || f.eventos.includes(orderEventId(o));

  // Who already has a (live) ticket for an excluded event.
  const excPhones = new Set();
  const excEmails = new Set();
  if (f.excluirEventos.length) {
    Object.values(db.orders || {}).forEach((o) => {
      if (o.status !== 'paid' || !f.excluirEventos.includes(orderEventId(o))) return;
      excPhones.add(phoneKey(o.buyerPhone)); excEmails.add(emailKey(o.buyerEmail));
    });
    Object.values(db.tickets || {}).forEach((t) => {
      const o = (db.orders || {})[t.orderId];
      if (!o || o.status !== 'paid' || t.status === 'cancelled' || !f.excluirEventos.includes(orderEventId(o))) return;
      excPhones.add(phoneKey(t.participantPhone)); excEmails.add(emailKey(t.participantEmail));
    });
    excPhones.delete(''); excEmails.delete('');
  }

  const pessoas = [];
  const porFone = new Map();
  const porEmail = new Map();
  const add = (nome, fone, email, origem, evento) => {
    const p = phoneKey(fone);
    const e = emailKey(email);
    if (!p && !e) return;
    let pessoa = (p && porFone.get(p)) || (e && porEmail.get(e));
    if (!pessoa) {
      pessoa = { nome: String(nome || '').trim().slice(0, 80), whatsapp: p, email: e, origens: new Set(), eventos: new Set() };
      pessoas.push(pessoa);
    }
    if (!pessoa.nome && nome) pessoa.nome = String(nome).trim().slice(0, 80);
    if (!pessoa.whatsapp && p) pessoa.whatsapp = p;
    if (!pessoa.email && e) pessoa.email = e;
    if (pessoa.whatsapp) porFone.set(pessoa.whatsapp, pessoa);
    if (pessoa.email) porEmail.set(pessoa.email, pessoa);
    pessoa.origens.add(origem);
    if (evento) pessoa.eventos.add(evento);
  };

  Object.values(db.orders || {}).forEach((o) => {
    if (o.loteName === 'Lote Teste' || !eventoOk(o)) return;
    const ev = getEventById(orderEventId(o)).name;
    const pago = o.status === 'paid';
    if (pago && !isGratuito(o) && fontes.has('pagos')) add(o.buyerName, o.buyerPhone, o.buyerEmail, 'pagos', ev);
    if (pago && isGratuito(o) && fontes.has('gratuitos')) add(o.buyerName, o.buyerPhone, o.buyerEmail, 'gratuitos', ev);
    if (['pending', 'rejected'].includes(o.status) && fontes.has('pendentes')) add(o.buyerName, o.buyerPhone, o.buyerEmail, 'pendentes', ev);
  });
  if (fontes.has('participantes')) {
    Object.values(db.tickets || {}).forEach((t) => {
      const o = (db.orders || {})[t.orderId];
      if (!o || o.status !== 'paid' || o.loteName === 'Lote Teste' || !eventoOk(o) || !t.participantName) return;
      add(t.participantName, t.participantPhone, t.participantEmail, 'participantes', getEventById(orderEventId(o)).name);
    });
  }
  if (fontes.has('musica')) Object.values(db.musicaPedidos || {}).forEach((p) => add(p.nome, String(p.remoteJid || '').split('@')[0], p.email, 'musica'));
  if (fontes.has('sorteio')) {
    const s = db.sorteio || {};
    Object.values(s.inscritos || {}).forEach((i) => add(i.nome, i.whatsapp, i.email, 'sorteio'));
    (s.arquivados || []).forEach((a) => Object.values((a && a.inscritos) || {}).forEach((i) => add(i.nome, i.whatsapp, i.email, 'sorteio')));
  }
  if (fontes.has('pesquisa')) Object.values(db.pesquisa || {}).forEach((r) => add(r.nome, r.whatsapp, r.email, 'pesquisa'));
  if (fontes.has('contatos')) Object.values(db.contatos || {}).forEach((c) => add(c.nome, c.whatsapp, c.email, 'contatos'));

  const optout = new Set(((db.automacoes && db.automacoes.optout) || []).map(String));
  return pessoas
    .filter((p) => !(p.whatsapp && excPhones.has(p.whatsapp)) && !(p.email && excEmails.has(p.email)))
    .filter((p) => !(p.whatsapp && optout.has(p.whatsapp)))
    .map((p) => ({ ...p, origens: [...p.origens], eventos: [...p.eventos] }));
}

function resumoPublico(db, filtros) {
  const lista = montarPublico(db, filtros);
  return {
    total: lista.length,
    comWhatsapp: lista.filter((p) => p.whatsapp).length,
    soEmail: lista.filter((p) => !p.whatsapp).length,
    exemplo: lista.slice(0, 6).map((p) => `${p.nome || 'Sem nome'}${p.eventos.length ? ` (${p.eventos.slice(0, 2).join(', ')})` : ''}`),
  };
}

function descreverFiltros(filtros) {
  const f = normalizarFiltros(filtros);
  const evs = f.eventos.length ? f.eventos.map((id) => getEventById(id).name).join(', ') : 'todos os eventos';
  const exc = f.excluirEventos.length ? ` · sem quem tem ingresso de ${f.excluirEventos.map((id) => getEventById(id).name).join(', ')}` : '';
  return `${f.fontes.map((x) => FONTES[x]).join(', ')} · ${evs}${exc}`;
}

module.exports = { FONTES, FONTES_DE_EVENTO, eventosComPedidos, montarPublico, resumoPublico, normalizarFiltros, descreverFiltros, EVENTS };
