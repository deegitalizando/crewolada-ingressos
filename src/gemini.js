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

// Every song must have a Christian angle (praise, family, love, gratitude, overcoming...).
// A Gemini check (webhook "Receber Validacao Letra" of the same n8n workflow) screens the lyrics
// before any payment is created. If the check itself is down the lyrics are let through (and
// logged) so a paying customer is never blocked by our tooling.
async function validarLetraCrista(letra) {
  const webhookUrl = process.env.N8N_MUSICA_VALIDAR_WEBHOOK_URL
    || 'https://n8n-n8n.wmbyj1.easypanel.host/webhook/crewolada-musica-validar';
  try {
    const { data } = await axios.post(webhookUrl, { letra }, { timeout: 25000 });
    return { aprovada: !(data && data.aprovada === false), motivo: String((data && data.motivo) || '') };
  } catch (err) {
    console.error('Validacao de letra indisponivel (liberada):', err.message);
    return { aprovada: true, motivo: 'nao-verificado' };
  }
}

const MENSAGEM_CUNHO_CRISTAO = 'As m\u00fasicas da Crewolada t\u00eam sempre cunho crist\u00e3o (louvor, fam\u00edlia, amor, gratid\u00e3o, supera\u00e7\u00e3o...). ';

module.exports = { draftLyrics, validarLetraCrista, MENSAGEM_CUNHO_CRISTAO };
