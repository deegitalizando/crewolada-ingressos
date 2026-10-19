const store = require('./store');
const { sendReminder } = require('./n8n');
const { getTemplates, renderTemplate } = require('./templates');

// How long to wait before nudging someone who started a music order but never
// finished paying, and before suggesting a past buyer create a new one.
// Both configurable since the right cadence is a business call, not a constant.
const ABANDONO_HORAS = Number(process.env.MUSICA_ABANDONO_HORAS || 2);
const RECOMPRA_DIAS = Number(process.env.MUSICA_RECOMPRA_DIAS || 45);

function linkMusica() {
  return `${process.env.BASE_URL || 'https://www.crewolada.com'}/criesuamusica`;
}

function hoursSince(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 3600000;
}

// Runs on a timer (not tied to any single order's lifecycle) and checks every
// stored order for one of two one-off nudges, each sent at most once per
// order (flagged on the order itself so a slow loop or a second process
// can't double-send):
//  - abandoned checkout: payment never confirmed, past the grace window.
//  - re-engagement: song delivered a while ago, suggest ordering another one
//    (also the natural hook for a commemorative-date push - see sendToAllMusicaBuyers
//    in reminders.js for a manually-scheduled version of that aimed at every
//    past buyer at once, e.g. for Valentine's Day or Christmas).
async function checkMusicaFollowUps() {
  const db = store.load();
  const pedidos = db.musicaPedidos || {};
  const templates = getTemplates(db);

  for (const pedido of Object.values(pedidos)) {
    if (!pedido.remoteJid && !pedido.email) continue;

    if (
      pedido.status === 'aguardando_pagamento' &&
      !pedido.lembreteAbandonoEnviado &&
      hoursSince(pedido.createdAt) >= ABANDONO_HORAS
    ) {
      await store.withDb((d) => {
        const p = (d.musicaPedidos || {})[pedido.id];
        if (p) p.lembreteAbandonoEnviado = true;
      });
      const mensagem = renderTemplate(templates.musicaAbandono, { nome: pedido.nome || '', link: linkMusica() });
      try {
        await sendReminder({ nome: pedido.nome, whatsapp: pedido.remoteJid || '', email: pedido.email, mensagem });
      } catch (err) {
        console.error(`Falha ao enviar lembrete de musica abandonada (${pedido.id}):`, err.message);
      }
    }

    if (
      pedido.status === 'entregue' &&
      !pedido.lembreteRecompraEnviado &&
      hoursSince(pedido.updatedAt || pedido.createdAt) >= RECOMPRA_DIAS * 24
    ) {
      await store.withDb((d) => {
        const p = (d.musicaPedidos || {})[pedido.id];
        if (p) p.lembreteRecompraEnviado = true;
      });
      const mensagem = renderTemplate(templates.musicaRecompra, { nome: pedido.nome || '', link: linkMusica() });
      try {
        await sendReminder({ nome: pedido.nome, whatsapp: pedido.remoteJid || '', email: pedido.email, mensagem });
      } catch (err) {
        console.error(`Falha ao enviar lembrete de recompra de musica (${pedido.id}):`, err.message);
      }
    }
  }
}

function startMusicaFollowUpScheduler() {
  const FIFTEEN_MINUTES = 15 * 60 * 1000;
  setInterval(() => {
    checkMusicaFollowUps().catch((err) => console.error('Erro no agendador de follow-up de musica:', err.message));
  }, FIFTEEN_MINUTES);
}

module.exports = { checkMusicaFollowUps, startMusicaFollowUpScheduler };
