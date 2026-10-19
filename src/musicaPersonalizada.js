const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const store = require('./store');
const mp = require('./mercadopago');
const { currentEvent } = require('./event');
const { notifyMusicaAprovada, notifyMusicaEmail } = require('./n8n');
const { isValidCpf } = require('./cpf');
const { draftLyrics, validarLetraCrista, MENSAGEM_CUNHO_CRISTAO } = require('./gemini');
const afiliados = require('./afiliados');

const PRECO = Number(process.env.MUSICA_PRECO || 10);

const ESTILOS = ['R&B', 'Soul', 'Neosoul', 'Hip-Hop', 'Boom Bap', 'Rap', 'Trap', 'Soulful Rap', 'Gospel/Louvor', 'Outro'];
// `value` is what's actually sent to the lyric/music generation prompts;
// `label` adds an approximate BPM range just so the picker reads as a tempo
// choice, not a mood choice.
// Vocal of the song (sent to the generator as a style hint).
const VOCAIS = [
  { value: 'Feminino', label: 'Feminino' },
  { value: 'Masculino', label: 'Masculino' },
  { value: 'Ambos', label: 'Ambos (feminino e masculino)' },
];
const vocalValido = (v) => (VOCAIS.some((x) => x.value === v) ? v : '');

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
async function criarPedidoMusica({ remoteJid, nome, cpf, email, estilo, andamento, vocal, letra, referencia, canal, afiliacao }, formData = null) {
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

  const transactionData = payment.point_of_interaction?.transaction_data || {};
  const pedido = {
    id,
    remoteJid: remoteJid || null,
    canal: canal || (remoteJid ? 'whatsapp' : 'site'),
    nome,
    cpf,
    email,
    estilo,
    andamento,
    vocal: vocalValido(vocal),
    afiliacao: afiliacao || null, // who gets commission for this sale (see afiliados.js)
    letra,
    referencia,
    valor: PRECO,
    status: 'aguardando_pagamento',
    mpPaymentId: String(payment.id),
    // Persisted so the /musica/pedido/:id status page can render the QR
    // code / copia-e-cola on reload or on first render after redirect —
    // the API response alone isn't enough, the page needs it too.
    pixCode: transactionData.qr_code || '',
    pixQrBase64: transactionData.qr_code_base64 || '',
    createdAt: new Date().toISOString(),
  };

  await store.withDb((db) => {
    db.musicaPedidos = db.musicaPedidos || {};
    db.musicaPedidos[id] = pedido;
  });

  if (payment.status === 'approved') {
    await aprovarPedidoMusica(id, payment.id);
  }

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

  if (pedido.afiliacao) {
    afiliados.registrarVenda(pedido).catch((err) => console.error('Falha ao registrar comissao de afiliado:', err.message));
  }
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

// ---- delivery: saved copy, download link, e-mail and WhatsApp --------------------------------
// The generator's audio URL can expire, so a copy of every finished song is kept next to the
// database (data/musicas/<id>.mp3) and served from our own address.
const AUDIO_DIR = path.join(__dirname, '..', 'data', 'musicas');
const audioPath = (id) => path.join(AUDIO_DIR, String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.mp3');
const baseUrl = () => (process.env.BASE_URL || '').replace(/\/$/, '');

// Short code the buyer sends on WhatsApp so the bot knows which song to deliver.
function codigoCurto(id) {
  return String(id).replace(/^musica_/, '').replace(/-/g, '').slice(0, 12).toUpperCase();
}
function buscarPedidoPorCodigo(codigo) {
  const c = String(codigo || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (c.length < 12) return null;
  const db = store.load();
  return Object.values(db.musicaPedidos || {}).find((p) => codigoCurto(p.id) === c) || null;
}

const MENSAGEM_WHATSAPP = 'Olá, gostaria de receber minha música por aqui.';
function whatsappMusicaUrl(pedido) {
  const ddi = process.env.DEFAULT_COUNTRY_CODE || '55';
  const raw = (process.env.BUSINESS_WHATSAPP_NUMBER || '2139557816').replace(/\D/g, '');
  const number = raw.startsWith(ddi) && raw.length > 11 ? raw : ddi + raw;
  return 'https://wa.me/' + number + '?text=' + encodeURIComponent(MENSAGEM_WHATSAPP + ' Código: ' + codigoCurto(pedido.id));
}

async function guardarAudio(pedido) {
  if (!pedido || !pedido.audioUrl) return false;
  try {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const res = await axios.get(pedido.audioUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 30 * 1024 * 1024 });
    fs.writeFileSync(audioPath(pedido.id), Buffer.from(res.data));
    return true;
  } catch (err) {
    console.error('Nao foi possivel guardar o audio do pedido ' + pedido.id + ':', err.message);
    return false;
  }
}

// After n8n reports the song ready: keep a copy and e-mail the buyer the listen/download link.
// Idempotent: n8n may repeat the callback, the e-mail goes out once.
async function posEntregaMusica(pedido) {
  if (!pedido) return;
  await guardarAudio(pedido);
  if (pedido.canal !== 'site' || !pedido.email) return;

  let enviar = false;
  await store.withDb((db) => {
    const p = (db.musicaPedidos || {})[pedido.id];
    if (p && !p.emailIniciadoEm) { p.emailIniciadoEm = new Date().toISOString(); enviar = true; }
  });
  if (!enviar) return;

  const pagina = baseUrl() + '/musica/pedido/' + pedido.id;
  const mensagem = [
    'Oi, ' + (pedido.nome || 'tudo bem') + '! Sua música personalizada ficou pronta 🎶🧡',
    '',
    'Ouça e baixe aqui: ' + pagina,
    'Download direto (MP3): ' + pagina + '/baixar',
    '',
    'Quer receber também no WhatsApp? Abra o link acima e toque em "Receber no WhatsApp".',
    '',
    'Equipe Crewolada',
  ].join('\n');
  try {
    await notifyMusicaEmail({ email: pedido.email, nome: pedido.nome, assunto: 'Sua música Crewolada ficou pronta 🎶', mensagem });
    await store.withDb((db) => { const p = (db.musicaPedidos || {})[pedido.id]; if (p) p.emailEnviadoEm = new Date().toISOString(); });
  } catch (err) {
    console.error('Falha ao enviar e-mail da musica ' + pedido.id + ':', err.message);
    await store.withDb((db) => { const p = (db.musicaPedidos || {})[pedido.id]; if (p) delete p.emailIniciadoEm; }); // allow a retry
  }
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
      vocais: VOCAIS,
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
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error('Erro ao rascunhar letra:', detail);
      return res.status(500).json({ error: 'Nao consegui sugerir uma letra agora, tente novamente em instantes.' });
    }
  });

  app.post('/api/musica/validar-letra', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return res.status(429).json({ error: 'Muitas tentativas, aguarde um pouco.' });
    const letra = String(req.body.letra || '').trim().slice(0, 4000);
    if (!letra) return res.status(400).json({ error: 'Preencha a letra.' });
    const v = await validarLetraCrista(letra);
    if (!v.aprovada) {
      return res.status(422).json({ ok: false, error: MENSAGEM_CUNHO_CRISTAO + (v.motivo ? 'Ajuste a letra: ' + v.motivo : 'Ajuste a letra e tente de novo.') });
    }
    return res.json({ ok: true });
  });

  app.post('/api/musica/pedido', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return res.status(429).json({ error: 'Muitas tentativas, aguarde um pouco.' });

    const nome = String(req.body.nome || '').trim().slice(0, 80);
    const email = String(req.body.email || '').trim().slice(0, 120);
    const cpfDigits = String(req.body.cpf || '').replace(/\D/g, '');
    const estilo = String(req.body.estilo || '').slice(0, 60);
    const andamento = String(req.body.andamento || '').slice(0, 60);
    const vocal = vocalValido(String(req.body.vocal || ''));
    const letra = String(req.body.letra || '').trim().slice(0, 4000);
    const referencia = String(req.body.referencia || '').trim().slice(0, 200);
    const formData = req.body.formData;

    if (!vocal) {
      return res.status(400).json({ error: 'Escolha o vocal (feminino, masculino ou ambos).' });
    }
    if (!nome || !email || !estilo || !letra || !formData) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatorios.' });
    }
    if (!isValidCpf(cpfDigits)) {
      return res.status(400).json({ error: 'CPF invalido.' });
    }

    const veredito = await validarLetraCrista(letra);
    if (!veredito.aprovada) {
      return res.status(422).json({ error: MENSAGEM_CUNHO_CRISTAO + (veredito.motivo ? 'Ajuste a letra: ' + veredito.motivo : 'Ajuste a letra e tente de novo.') });
    }

    try {
      const resultado = await criarPedidoMusica(
        {
          nome, cpf: cpfDigits, email, estilo, andamento, vocal, letra, referencia, canal: 'site',
          afiliacao: afiliados.atribuirCompra({ vid: req.cookies && req.cookies[afiliados.COOKIE_VID], email, cpf: cpfDigits }),
        },
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
    res.render('musica_status', {
      eventInfo,
      pedido,
      codigo: codigoCurto(pedido.id),
      whatsappUrl: whatsappMusicaUrl(pedido),
      audioSrc: '/musica/pedido/' + pedido.id + '/audio',
    });
  });

  // Audio of a finished song: inline for the player (and for the WhatsApp bot), or as a download.
  function enviarAudio(req, res, attachment) {
    const pedido = buscarPedidoMusica(req.params.id);
    if (!pedido || pedido.status !== 'entregue' || !pedido.audioUrl) return res.status(404).send('Musica nao encontrada.');
    const file = audioPath(pedido.id);
    const nome = 'minha-musica-crewolada.mp3';
    res.set('Cache-Control', 'private, max-age=3600');
    if (fs.existsSync(file)) {
      if (attachment) return res.download(file, nome);
      res.type('audio/mpeg');
      return res.sendFile(file);
    }
    // No local copy (yet): stream it from the generator.
    return axios.get(pedido.audioUrl, { responseType: 'stream', timeout: 30000 }).then((up) => {
      res.type('audio/mpeg');
      if (attachment) res.set('Content-Disposition', 'attachment; filename="' + nome + '"');
      up.data.pipe(res);
    }).catch(() => res.status(502).send('Nao foi possivel carregar a musica agora.'));
  }
  app.get('/musica/pedido/:id/audio', (req, res) => enviarAudio(req, res, false));
  app.get('/musica/pedido/:id/baixar', (req, res) => enviarAudio(req, res, true));

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
  posEntregaMusica,
  buscarPedidoMusica,
  buscarPedidoPorCodigo,
  codigoCurto,
  registerMusicaPersonalizadaRoutes,
  PRECO,
  vocalValido,
  validarLetraCrista,
};
