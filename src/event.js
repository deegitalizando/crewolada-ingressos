// Events the app sells tickets for. Every order carries an eventId so lotes,
// stock, reminders and reports of one event never bleed into another.
//
// Events come from two places, merged:
//  - built-in seeds below (the first event and the one currently on sale);
//  - db.events, created/edited by the admin in /admin/eventos.
// db.currentEventId says which event is on sale on the public site.
// Orders created before events existed have no eventId: they belong to LEGACY.
const LEGACY_EVENT = {
  id: 'crewolada-2026-10-10',
  name: 'Crewolada',
  brand: 'Crewolada',
  dateLabel: '10/10/2026',
  timeLabel: '',
  venue: 'Bangu Atletico Clube - Rio de Janeiro/RJ',
  startAt: '2026-10-11T01:00:00.000Z', // 10/10/2026 22h (Brasilia)
};

const NEXT_EVENT = {
  id: 'tardezinha-2026-11-14',
  name: 'Tardezinha Crewolada',
  brand: 'Crewolada',
  dateLabel: '14/11/2026',
  timeLabel: 'Das 15h às 22h',
  venue: 'Rio da Prata - Campo Grande/RJ',
  startAt: '2026-11-14T18:00:00.000Z', // 14/11/2026 15h (Brasilia)
  capacity: 300,
  // Programmed here so the sale opens on deploy; editable later in /admin/ingressos.
  defaultLotes: [{ name: 'Lote Único', quantity: 300, price: 25 }],
  childRules: { freeUntil: 2, halfUntil: 12, freeCountsInCapacity: false },
  products: [
    { id: 'simples', name: 'Ingresso Simples', price: 25, includes: [] },
    { id: 'passaporte', name: 'Passaporte', price: 100, includes: ['Churrasco', 'Refrigerante', 'Algodão doce'] },
  ],
};

// Free, limited registration with its own page (crewolada.com/SP). It is sold in
// parallel with the "current" event, so it never needs to be set as current.
const SP_EVENT = {
  id: 'crewolada-sp-2026-11-19',
  name: 'Crewolada SP',
  brand: 'Crewolada',
  slug: 'sp',
  free: true,
  tagline: 'Pela 1ª vez em São Paulo',
  note: 'Véspera de feriado',
  dateLabel: '19/11/2026',
  timeLabel: 'Das 19h às 23h',
  venue: 'Igreja Somos Betel - Osasco/SP',
  startAt: '2026-11-19T22:00:00.000Z', // 19/11/2026 19h (Brasilia)
  capacity: 500,
  maxPerCpf: 4,
};

const SEEDS = [LEGACY_EVENT, NEXT_EVENT, SP_EVENT];

// Both are mutated IN PLACE by syncEvents(), so every module that imported
// them keeps seeing the live values without re-requiring anything.
const EVENTS = [];
const currentEvent = {};

// A different event can be forced without the panel by setting EVENT_ID (and
// the usual EVENT_* variables). Otherwise db.currentEventId decides.
function envEvent() {
  if (!process.env.EVENT_ID) return null;
  return {
    id: process.env.EVENT_ID,
    name: process.env.EVENT_NAME || 'Evento',
    brand: process.env.EVENT_BRAND || 'Crewolada',
    dateLabel: process.env.EVENT_DATE_LABEL || '',
    timeLabel: process.env.EVENT_TIME_LABEL || '',
    venue: process.env.EVENT_VENUE || '',
    startAt: process.env.EVENT_START_AT || null,
    capacity: Number(process.env.EVENT_CAPACITY) || null,
  };
}

function syncEvents(db) {
  const overlay = (db && db.events) || {};
  const map = {};
  SEEDS.forEach((e) => { map[e.id] = { ...e, ...(overlay[e.id] || {}), id: e.id }; });
  Object.values(overlay).forEach((e) => {
    if (e && e.id && !map[e.id]) map[e.id] = { brand: 'Crewolada', timeLabel: '', ...e };
  });
  const env = envEvent();
  if (env) map[env.id] = { ...(map[env.id] || {}), ...env };

  const list = Object.values(map).sort((a, b) => String(a.startAt || '9999').localeCompare(String(b.startAt || '9999')));
  EVENTS.length = 0;
  list.forEach((e) => EVENTS.push(e));

  const wanted = env ? env.id : (db && db.currentEventId) || NEXT_EVENT.id;
  const chosen = map[wanted] || map[NEXT_EVENT.id];
  Object.keys(currentEvent).forEach((k) => delete currentEvent[k]);
  Object.assign(currentEvent, chosen);
}

syncEvents(null);

const orderEventId = (order) => (order && order.eventId) || LEGACY_EVENT.id;
const inEvent = (order, eventId) => orderEventId(order) === eventId;
const getEventById = (id) => EVENTS.find((e) => e.id === id) || LEGACY_EVENT;
const eventForOrder = (order) => getEventById(orderEventId(order));

// 'atual' = on sale now; 'anterior' = already happened; 'futuro' = still to come.
function eventStatus(event, now = Date.now()) {
  if (event.id === currentEvent.id) return 'atual';
  const t = event.startAt ? Date.parse(event.startAt) : NaN;
  if (!Number.isNaN(t) && t < now) return 'anterior';
  return 'futuro';
}

// Variables available to message templates ({{evento}}, {{data}}...).
function eventTemplateVars(event = currentEvent) {
  return { evento: event.name, data: event.dateLabel, hora: event.timeLabel || '', local: event.venue };
}

module.exports = {
  LEGACY_EVENT, NEXT_EVENT, SP_EVENT, EVENTS, currentEvent, syncEvents,
  orderEventId, inEvent, getEventById, eventForOrder, eventStatus, eventTemplateVars,
};
