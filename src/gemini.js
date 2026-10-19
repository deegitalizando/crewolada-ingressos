const axios = require('axios');

// Drafts song lyrics for the /criesuamusica page. Called directly from the
// Node backend (not through n8n) so the page gets a draft back synchronously
// while the visitor waits, without a round trip through the WhatsApp workflow.
async function draftLyrics({ estilo, andamento, detalhes, referencia }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY nao configurada.');
  }

  const prompt = [
    'Voce escreve letras de musica para o bot "Crie Sua Propria Musica" da Crewolada,',
    'uma festa de Black Music Crista (R&B, Soul, Neosoul, Hip-Hop, Rap, Trap, Soulful Rap).',
    'Escreva uma letra ORIGINAL em portugues do Brasil, curta (12 a 20 linhas), sem repetir',
    'frases genericas demais, com uma mensagem positiva/de fe quando fizer sentido pelo tema.',
    'Responda APENAS com a letra, sem titulo, sem explicacao, sem aspas.',
    '',
    `Estilo musical: ${estilo || 'nao informado'}`,
    `Andamento desejado: ${andamento || 'nao informado'}`,
    referencia ? `Referencia de som/artista: ${referencia}` : '',
    `Detalhes para a letra (tema, ocasiao, pessoas, historia): ${detalhes || 'nao informado'}`,
  ].filter(Boolean).join('\n');

  const { data } = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
    { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
    { timeout: 20000 }
  );

  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return texto.trim();
}

module.exports = { draftLyrics };
