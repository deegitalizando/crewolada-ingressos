const axios = require('axios');
const nodemailer = require('nodemailer');

function normalizePhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return null;
  const ddi = process.env.DEFAULT_COUNTRY_CODE || '55';
  if (digits.startsWith(ddi) && digits.length > 11) return digits;
  return `${ddi}${digits}`;
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] != null ? vars[key] : ''));
}

// Envia via n8n (um workflow com node Webhook + node da Evolution API, igual
// ao workflow "WORKFLOW CREWOLADA" ja existente na VPS do usuario) ou direto
// pela Evolution API, dependendo de MESSAGING_MODE.
async function sendWhatsapp({ telefone, mensagem, leadId, nomeNegocio }) {
  const numero = normalizePhone(telefone);
  if (!numero) throw new Error('Telefone invalido ou nao informado.');

  const mode = (process.env.MESSAGING_MODE || 'n8n').toLowerCase();

  if (mode === 'evolution_direct') {
    const baseUrl = process.env.EVOLUTION_API_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;
    const instance = process.env.EVOLUTION_INSTANCE;
    if (!baseUrl || !apiKey || !instance) {
      throw new Error(
        'MESSAGING_MODE=evolution_direct exige EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE no .env.'
      );
    }
    await axios.post(
      `${baseUrl.replace(/\/$/, '')}/message/sendText/${instance}`,
      { number: numero, text: mensagem },
      { headers: { apikey: apiKey }, timeout: 15000 }
    );
    return { numero };
  }

  const webhookUrl = process.env.N8N_PROSPECCAO_WHATSAPP_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('N8N_PROSPECCAO_WHATSAPP_WEBHOOK_URL nao configurada (ou use MESSAGING_MODE=evolution_direct).');
  }
  await axios.post(
    webhookUrl,
    { telefone: numero, mensagem, leadId, nomeNegocio },
    { timeout: 15000 }
  );
  return { numero };
}

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP_HOST, SMTP_USER e SMTP_PASS precisam estar configurados no .env para enviar e-mail.');
  }
  cachedTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cachedTransporter;
}

async function sendEmail({ to, subject, text }) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}

module.exports = { normalizePhone, renderTemplate, sendWhatsapp, sendEmail };
