const store = require('./store');
const { sendReminder } = require('./n8n');
const { getTemplates, renderTemplate } = require('./templates');

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

async function sendToAllPaidBuyers(db, messageTemplate) {
  const buyers = Object.values(db.orders).filter((o) => o.status === 'paid');
  for (const order of buyers) {
    const mensagem = renderTemplate(messageTemplate, { nome: order.buyerName });
    try {
      await sendReminder({
        nome: order.buyerName,
        whatsapp: order.buyerPhone,
        email: order.buyerEmail,
        mensagem,
      });
    } catch (err) {
      console.error(`Falha ao enviar mensagem para ${order.buyerEmail}:`, err.message);
    }
  }
}

async function checkAndSendReminders() {
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

        await sendToAllPaidBuyers(db, templates[key]);
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

    await sendToAllPaidBuyers(db, campaign.mensagem);
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
