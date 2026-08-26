const axios = require('axios');

function normalizePhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  const ddi = process.env.DEFAULT_COUNTRY_CODE || '55';
  if (digits.startsWith(ddi) && digits.length > 11) return digits;
  return `${ddi}${digits}`;
}

// Matches the fields expected by the "WORKFLOW CREWOLADA" n8n workflow (node
// "Receber Ingresso Aprovado"), which sends the ticket PDF via WhatsApp
// (Evolution API) and by e-mail (Gmail) in parallel. One HTTP call is made
// per ticket so each buyer gets one PDF per person.
async function notifyOrderApproved(order, tickets) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('N8N_WEBHOOK_URL nao configurada, pulando notificacao.');
    return;
  }

  const whatsapp = normalizePhone(order.buyerPhone);

  for (const ticket of tickets) {
    const payload = {
      nome: order.buyerName,
      email: order.buyerEmail,
      nomeLote: order.loteName,
      codigo: ticket.code,
      whatsapp,
      pdfBase64: ticket.pdfBase64,
      fileName: `ingresso-${ticket.code}.pdf`,
    };

    try {
      await axios.post(webhookUrl, payload, { timeout: 15000 });
    } catch (err) {
      console.error(`Falha ao notificar n8n para o ingresso ${ticket.code}:`, err.message);
    }
  }
}

async function sendBroadcast(message) {
  const webhookUrl = process.env.N8N_BROADCAST_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('N8N_BROADCAST_WEBHOOK_URL nao configurada.');
  }
  await axios.post(webhookUrl, { mensagem: message }, { timeout: 10000 });
}

module.exports = { notifyOrderApproved, normalizePhone, sendBroadcast };
