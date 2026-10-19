const crypto = require('crypto');
const store = require('./store');
const mp = require('./mercadopago');
const { currentEvent } = require('./event');
const { notifyMusicaAprovada } = require('./n8n');
const { isValidCpf } = require('./cpf');
const { draftLyrics } = require('./gemini');

const PRECO = Number(process.env.MUSICA_PRECO || 10);

const ESTILOS = ['R&B', 'Soul', 'Neosoul', 'Hip-Hop', 'Rap', 'Trap', 'Soulful Rap', 'Gospel/Louvor', 'Outro'];
// `value` is what's actually sent to the lyric/music generation prompts;
// `label` adds an approximate BPM range just so the picker reads as a tempo
// choice, not a mood choice.
const ANDAMENTOS = [
  { value: 'Lenta e suave', label: 'Lenta e suave (~70-90 BPM)' },
  { value: 'Media', label: 'Media (~95-115 BPM)' },
  { value: 'Acelerada e dancante', label: 'Acelerada e dancante (~120-150 BPM)' },
];

// Simple per-IP throttle for the public endpoints below (payment creation and
// AI lyric drafts both cost real money/API calls, so an open page needs some
// abuse protection even without a login), same approach as pesquisa.js.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 12;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_MAX;
}

// Creates the charge for a custom-song order (style, tempo, lyrics and
// reference already gathered and approved by the buyer, before any payment).
// Two origins share this function:
//  - the WhatsApp bot (remoteJid set, no formData): Pix-only, since there's
//    no card UI over chat — the code/QR is sent as a message.
//  - the /criesuamusica page (formData from the Payment Brick): card or Pix,
//    buyer's choice, same as the ticket checkout.
// Ids are prefixed "musica_" and live in db.musicaPedidos (not db.orders) so
// the shared Mercado Pago webhook can tell the two products apart.
async function criarPedidoMusica({ remoteJid, nome, cpf, email, estilo, andamento, letra, referencia, canal }, formData = null) {
  const id = `musica_${crypto.randomUUID()}`;
  const description = `Musica personalizada - ${currentEvent.brand || 'Crewolada'}`;

  const payment = formData
    ? await mp.createBrickPayment({
        amount: PRECO,
        description,
        formData,
        payerEmail: email,
        payerCpf: cpf,
        externalReference: id,
      })
    : await mp.createPixPayment({
        amount: PRECO,
        description,
        payerEmail: email || 'sem-email@crewolada.com',
        payerCpf: cpf,
        externalReference: id,
      });

  if (payment.status === 'rejected') {
    return { rejected: true, statusDetail: payment.status_detail };
  }

  const pedido = {
    id,
    remoteJid: remoteJid || null,
    canal: canal || (remoteJid ? 'whatsapp' : 'site'),
    nome,
    cpf,
    email,
    estilo,
    andamento,
    letra,
    referencia,
    valor: PRECO,
    status: 'aguardando_pagamento',
    mpPaymentId: String(payment.id),
    createdAt: new Date().toISOString(),
  };

  await store.withDb((db) => {
    db.musicaPedidos = db.musicaPedidos || {};
    db.musicaPedidos[id] = pedido;
  });

  if (payment.status === 'approved') {
    await aprovarPedidoMusica(id, payment.id);
  }

  const transactionData = payment.point_of_interaction?.transaction_data || {};
  return {
    pedidoId: id,
    status: payment.status,
    pixCode: transactionData.qr_code || '',
    pixQrBase64: transactionData.qr_code_base64 || '',
    valor: PRECO,
  };
}

// Marks a music order paid and tells n8n to generate and deliver the song.
// Idempotent like approveOrder: whichever webhook delivery arrives first wins.
async function aprovarPedidoMusica(pedidoId, paymentId) {
  let pedido = null;

  await store.withDb((db) => {
    db.musicaPedidos = db.musicaPedidos || {};
    const p = db.musicaPedidos[pedidoId];
    if (!p) return;
    if (p.status === 'pago' || p.status === 'gerando' || p.status === 'entregue') return;

    p.status = 'pago';
    p.mpPaymentId = String(paymentId);
    p.updatedAt = new Date().toISOString();
    pedido = { ...p };
  });

  if (!pedido) return null;

  await notifyMusicaAprovada(pedido);
  return pedido;
}

// Called by n8n once Mureka finishes the song, so the /criesuamusica status
// page can show/play it. WhatsApp-originated orders are delivered straight
// to the buyer's chat by n8n itself and don't need this, but it's harmless
// to record the link for them too (visible if they also check the site).
async function marcarMusicaPronta(pedidoId, audioUrl) {
  let pedido = null;
  await store.withDb((db) => {
    db.musicaPedidos = db.musicaPedidos || {};
    const p = db.musicaPedidos[pedidoId];
    if (!p) return;
    p.status = 'entregue';
    p.audioUrl = audioUrl;
    p.updatedAt = new Date().toISOString();
    pedido = { ...p };
  });
  return pedido;
}

function buscarPedidoMusica(pedidoId) {
  const db = store.load();
  return (db.musicaPedidos || {})[pedidoId] || null;
}

function registerMusicaPersonalizadaRoutes(app, { eventInfo }) {
  app.get('/criesuamusica', (req, res) => {
    res.render('criesuamusica', {
      eventInfo,
      estilos: ESTILOS,
      andamentos: ANDAMENTOS,
      preco: PRECO,
      mpPublicKey: process.env.MP_PUBLIC_KEY,
    });
  });

  app.post('/api/musica/rascunhar-letra', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return res.status(429).json({ error: 'Muitas tentativas, aguarde um pouco.' });

    const estilo = String(req.body.estilo || '').slice(0, 60);
    const andamento = String(req.body.andamento || '').slice(0, 60);
    const detalhes = String(req.body.detalhes || '').slice(0, 1000);
    const referencia = String(req.body.referencia || '').slice(0, 200);
    if (!detalhes) return res.status(400).json({ error: 'Conte um pouco sobre a musica primeiro.' });

    try {
      const letra = await draftLyrics({ estilo, andamento, detalhes, referencia });
      if (!letra) throw new Error('resposta vazia');
      return res.json({ letra });
    } catch (err) {
      console.error('Erro ao rascunhar letra:', err.message);
      // TEMP debug: surface the real cause in the response while we track this
      // down (no server log access from here). Remove once resolved.
      const debugDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      return res.status(500).json({ error: 'Nao consegui sugerir uma letra agora, tente novamente em instantes.', debugDetail });
    }
  });

  app.post('/api/musica/pedido', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return res.status(429).json({ error: 'Muitas tentativas, aguarde um pouco.' });

    const nome = String(req.body.nome || '').trim().slice(0, 80);
    const email = String(req.body.email || '').trim().slice(0, 120);
    const cpfDigits = String(req.body.cpf || '').replace(/\D/g, '');
    const estilo = String(req.body.estilo || '').slice(0, 60);
    const andamento = String(req.body.andamento || '').slice(0, 60);
    const letra = String(req.body.letra || '').trim().slice(0, 4000);
    const referencia = String(req.body.referencia || '').trim().slice(0, 200);
    const formData = req.body.formData;

    if (!nome || !email || !estilo || !letra || !formData) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatorios.' });
    }
    if (!isValidCpf(cpfDigits)) {
      return res.status(400).json({ error: 'CPF invalido.' });
    }

    try {
      const resultado = await criarPedidoMusica(
        { nome, cpf: cpfDigits, email, estilo, andamento, letra, referencia, canal: 'site' },
        formData
      );
      if (resultado.rejected) {
        return res.status(400).json({ error: 'Pagamento recusado. Tente outro cartao ou escolha Pix.' });
      }
      return res.json({ redirectUrl: `/musica/pedido/${resultado.pedidoId}` });
    } catch (err) {
      console.error('Erro ao criar pedido de musica (site):', err.message);
      return res.status(500).json({ error: 'Nao foi possivel processar o pagamento.' });
    }
  });

  app.get('/musica/pedido/:id', (req, res) => {
    const pedido = buscarPedidoMusica(req.params.id);
    if (!pedido || pedido.canal !== 'site') return res.status(404).send('Pedido nao encontrado.');
    res.render('musica_status', { eventInfo, pedido });
  });

  app.get('/api/musica/pedido/:id/status', (req, res) => {
    const pedido = buscarPedidoMusica(req.params.id);
    if (!pedido || pedido.canal !== 'site') return res.status(404).json({ error: 'not_found' });
    res.json({ status: pedido.status, audioUrl: pedido.audioUrl || null });
  });
}

module.exports = {
  criarPedidoMusica,
  aprovarPedidoMusica,
  marcarMusicaPronta,
  buscarPedidoMusica,
  registerMusicaPersonalizadaRoutes,
  PRECO,
};
