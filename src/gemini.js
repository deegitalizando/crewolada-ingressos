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
    'Escreva uma letra ORIGINAL, COMPLETA, em portugues do Brasil, com estrutura de musica',
    'inteira (nao um trecho curto): Verse 1, Chorus, Verse 2, Chorus, Bridge, Chorus final,',
    'marcando cada secao entre colchetes (ex: [Verse 1], [Chorus], [Bridge]) em ingles mesmo',
    'com o conteudo em portugues, pois e assim que o gerador de musica reconhece a estrutura.',
    'O refrao (Chorus) deve repetir com a mesma letra todas as vezes que aparecer.',
    'A letra completa deve ter entre 26 e 34 linhas de conteudo cantado (fora as marcacoes de',
    'secao), o suficiente para gerar uma musica de aproximadamente 3 minutos. Sem repetir',
    'frases genericas demais, com uma mensagem positiva/de fe quando fizer sentido pelo tema.',
    'Responda APENAS com a letra (incluindo as marcacoes de secao), sem titulo, sem explicacao, sem aspas.',
    '',
    `Estilo musical: ${estilo || 'nao informado'}`,
    `Andamento desejado: ${andamento || 'nao informado'}`,
    referencia ? `Referencia de som/artista: ${referencia}` : '',
    `Detalhes para a letra (tema, ocasiao, pessoas, historia): ${detalhes || 'nao informado'}`,
  ].filter(Boolean).join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };

  // Gemini's shared "flash-latest" endpoint occasionally answers 503/429
  // under high demand — transient, not a config problem. Retry a couple of
  // times with backoff before giving up.
  const MAX_TRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const { data } = await axios.post(url, body, { timeout: 20000 });
      const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return texto.trim();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retriable = status === 503 || status === 429;
      if (!retriable || attempt === MAX_TRIES) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastErr;
}

module.exports = { draftLyrics };
