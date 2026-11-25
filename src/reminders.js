const store = require('./store');
const { getTemplates } = require('./templates');
const { enfileirar } = require('./waFila');
const { montarPublico } = require('./publico');
const { currentEvent, inEvent, eventTemplateVars, EVENTS, getEventById } = require('./event');

const MILESTONES = ['dias5', 'dia1', 'diaEvento', 'hora1'];

// Milestone datetimes derived from the event's start instant. All computed
// in Brasilia time (UTC-3, no DST since 2019) regardless of the server's own
// OS timezone, so the schedule doesn't drift depending on where this runs.
function getMilestoneDates(eventStartAt) {
  const start = new Date(eventStartAt);
  if (Number.isNaN(start.getTime())) return null;

  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(start)
    .split('-');
  const diaEvento = new Date(`${year}-${month}-${day}T09:00:00-03:00`); // morning-of reminder

  return {
    dias5: new Date(start.getTime() - 5 * 24 * 60 * 60 * 1000),
    dia1: new Date(start.getTime() - 1 * 24 * 60 * 60 * 1000),
    diaEvento,
    hora1: new Date(start.getTime() - 60 * 60 * 1000),
  };
}

// Mass sends never go out back-to-back: they enter the protected WhatsApp queue
// (src/waFila.js), which sends one every ~2 min (editable in /admin/mensagens),
// in different versions of the text, inside the daily window and limit.
async function sendToAllPaidBuyers(db, messageTemplate, eventId = currentEvent.id, titulo = 'Lembrete') {
  if (getEventById(eventId).cancelledAt) return; // cancelled events send no reminders
  const buyers = Object.values(db.orders).filter((o) => o.status === 'paid' && inEvent(o, eventId));
  await enfileirar({
    origem: 'ingressos',
    titulo: `${titulo} · ${getEventById(eventId).name}`,
    template: messageTemplate,
    varsBase: eventTemplateVars(getEventById(eventId)),
    destinatarios: buyers.map((o) => ({ nome: o.buyerName, whatsapp: o.buyerPhone, email: o.buyerEmail })),
  });
}

// Same broadcast, aimed at everyone who has ever received a custom song -
// the admin-scheduled counterpart to the automatic re-engagement nudge in
// musicaFollowUps.js, meant for a one-off push tied to a calendar date (e.g.
// Dia dos Namorados, Natal) rather than to how long ago each buyer ordered.
async function sendToAllMusicaBuyers(db, messageTemplate) {
  const buyers = Object.values(db.musicaPedidos || {}).filter((p) => p.status === 'entregue');
  await enfileirar({
    origem: 'musica',
    titulo: 'Campanha · compradores de música',
    template: messageTemplate,
    varsBase: { link: `${process.env.BASE_URL || 'https://www.crewolada.com'}/criesuamusica` },
    destinatarios: buyers.map((p) => ({ nome: p.nome, whatsapp: String(p.remoteJid || '').split('@')[0], email: p.email })),
  });
}

const MILESTONE_LABEL = { dias5: '5 dias antes', dia1: '1 dia antes', diaEvento: 'No dia', hora1: '1 hora antes' };

async function checkAndSendReminders() {
  // First run for a new event: point the milestones at its start time and
  // clear the "already sent" flags left over from the previous event.
  if (store.load().remindersEventId !== currentEvent.id) {
    await store.withDb((d) => {
      d.remindersEventId = currentEvent.id;
      if (currentEvent.startAt) d.eventStartAt = currentEvent.startAt;
      d.remindersSent = {};
    });
  }
  const db = store.load();

  // Fixed milestones tied to the event date.
  if (db.eventStartAt) {
    const milestoneDates = getMilestoneDates(db.eventStartAt);
    if (milestoneDates) {
      const sent = db.remindersSent || {};
      const now = new Date();
      const templates = getTemplates(db);

      for (const key of MILESTONES) {
        if (sent[key]) continue;
        if (now < milestoneDates[key]) continue;

        // Claim this milestone immediately so a slow send loop (or a second
        // process) can't fire it twice.
        await store.withDb((d) => {
          d.remindersSent = d.remindersSent || {};
          d.remindersSent[key] = true;
        });

        await sendToAllPaidBuyers(db, templates[key], currentEvent.id, MILESTONE_LABEL[key]);
      }
    }
  }

  // Other upcoming events that already have registrations (e.g. the free SP event
  // sold in parallel with the current one) get the same reminder milestones,
  // tracked per event. Milestones that are already stale (someone registered
  // late) are marked as done instead of being sent out of context.
  {
    const nowMs = Date.now();
    const templates = getTemplates(db);
    for (const ev of EVENTS) {
      if (ev.id === currentEvent.id || !ev.startAt) continue;
      if (nowMs > Date.parse(ev.startAt) + 3 * 3600000) continue;
      if (!Object.values(db.orders).some((o) => o.status === 'paid' && inEvent(o, ev.id))) continue;
      const dates = getMilestoneDates(ev.startAt);
      if (!dates) continue;
      const flags = (db.eventReminders || {})[ev.id] || {};
      for (const key of MILESTONES) {
        if (flags[key] || nowMs < dates[key].getTime()) continue;
        const stale = nowMs - dates[key].getTime() > 12 * 3600000;
        await store.withDb((d) => {
          d.eventReminders = d.eventReminders || {};
          d.eventReminders[ev.id] = d.eventReminders[ev.id] || {};
          d.eventReminders[ev.id][key] = true;
        });
        if (!stale) await sendToAllPaidBuyers(db, templates[key], ev.id, MILESTONE_LABEL[key]);
      }
    }
  }

  // Free-form scheduled campaigns created in /admin/mensagens.
  const campaigns = db.campaigns || [];
  const now = new Date();
  for (const campaign of campaigns) {
    if (campaign.sent) continue;
    if (now < new Date(campaign.sendAt)) continue;

    await store.withDb((d) => {
      const c = (d.campaigns || []).find((x) => x.id === campaign.id);
      if (c) c.sent = true;
    });

    if (campaign.filtros) {
      const pessoas = montarPublico(store.load(), campaign.filtros);
      await enfileirar({
        origem: 'campanha',
        titulo: `Campanha · ${pessoas.length} pessoas`,
        template: campaign.mensagem,
        varsBase: { ...eventTemplateVars(currentEvent), link: `${process.env.BASE_URL || 'https://crewolada.com'}` },
        destinatarios: pessoas.map((p) => ({ nome: p.nome, whatsapp: p.whatsapp, email: p.email })),
      });
      continue;
    }
    if (campaign.audiencia === 'musica' || campaign.audiencia === 'todos') {
      await sendToAllMusicaBuyers(db, campaign.mensagem);
    }
    if (campaign.audiencia !== 'musica') {
      await sendToAllPaidBuyers(db, campaign.mensagem, currentEvent.id, 'Campanha');
    }
  }
}

function startReminderScheduler() {
  const FIVE_MINUTES = 5 * 60 * 1000;
  setInterval(() => {
    checkAndSendReminders().catch((err) => console.error('Erro no agendador de lembretes:', err.message));
  }, FIVE_MINUTES);
}

module.exports = {
  getMilestoneDates,
  checkAndSendReminders,
  startReminderScheduler,
};
