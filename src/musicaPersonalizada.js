const crypto = require('crypto');
const store = require('./store');
const mp = require('./mercadopago');
const { notifyMusicaAprovada } = require('./n8n');

const PRECO = Number(process.env.MUSICA_PRECO || 10);

// Creates the Pix charge for a custom-song order collected by the WhatsApp
// bot (style, tempo, lyrics and reference already gathered and approved by
// the buyer in conversation, before any money changes hands). Mirrors
// mercadopago.createPixPayment + the db.orders pattern used for tickets, but
// keyed separately (db.musicaPedidos, ids prefixed "musica_") so the shared
// Mercado Pago webhook can tell the two products apart.
async function criarPedidoMusica({ remoteJid, nome, cpf, email, estilo, andamento, letra, referencia }) {
  const id = `musica_${crypto.randomUUID()}`;

  const payment = await mp.createPixPayment({
    amount: PRECO,
    description: `Musica personalizada - ${process.env.EVENT_NAME || 'Crewolada'}`,
    payerEmail: email || 'sem-email@crewolada.com',
    payerCpf: cpf,
    externalReference: id,
  });

  const pedido = {
    id,
    remoteJid,
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

  const transactionData = payment.point_of_interaction?.transaction_data || {};
  return {
    pedidoId: id,
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

module.exports = { criarPedidoMusica, aprovarPedidoMusica };
