const axios = require('axios');

// Drafts song lyrics for the /criesuamusica page by asking the "WORKFLOW
// CREWOLADA" n8n workflow (node "Gerar Letra Musica (Gemini)") to do it.
// That node reuses the same Gemini credential already powering the
// WhatsApp FAQ bot, so this feature needs no API key or billing of its
// own — one Gemini account, one invoice, same as the rest of the project.
async function draftLyrics({ estilo, andamento, detalhes, referencia }) {
  const webhookUrl = process.env.N8N_MUSICA_LETRA_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('N8N_MUSICA_LETRA_WEBHOOK_URL nao configurada.');
  }

  const { data } = await axios.post(
    webhookUrl,
    { estilo, andamento, detalhes, referencia },
    { timeout: 25000 }
  );

  if (!data?.letra) {
    throw new Error(data?.erro || 'Resposta invalida do gerador de letra.');
  }
  return String(data.letra).trim();
}

module.exports = { draftLyrics };
