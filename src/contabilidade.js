const crypto = require('crypto');
const store = require('./store');
const mp = require('./mercadopago');

// Borderô do evento: dois setores independentes (bilheteria e bar), cada um
// com suas entradas e custos, pra saber se cada setor se pagou e qual foi o
// resultado do evento somando os dois.
const SETORES = {
  bilheteria: {
    label: 'Bilheteria',
    categoriasCusto: [
      'Salão / locação do espaço', 'Som', 'Iluminação', 'Palco e estrutura', 'Camarim', 'Atrações / artistas', 'DJs',
      'Apresentador / MC', 'Segurança', 'Bombeiro / brigada', 'Recepção / portaria', 'Limpeza', 'Equipe de produção',
      'Decoração', 'Gerador / energia', 'Fotografia e vídeo', 'Divulgação / anúncios', 'Impressos / pulseiras',
      'Alimentação da equipe', 'Transporte / frete', 'Hospedagem', 'Taxas e licenças (ECAD, alvará)', 'Outros',
    ],
    categoriasEntrada: ['Venda na porta', 'Patrocínio', 'Apoio / permuta', 'Lista / promoter', 'Estacionamento', 'Outros'],
  },
  bar: {
    label: 'Bar',
    categoriasCusto: [
      'Bebidas', 'Gelo', 'Descartáveis (copos, canudos)', 'Comida / insumos', 'Equipe do bar',
      'Aluguel de freezer / equipamento', 'Taxa da maquininha', 'Outros',
    ],
    categoriasEntrada: ['Fechamento de caixa', 'Maquininha', 'Pix', 'Dinheiro', 'Fichas / consumação', 'Outros'],
  },
};

const FORMAS = ['Pix', 'Dinheiro', 'Cartão de débito', 'Cartão de crédito', 'Transferência', 'Outro'];

// MP statuses where the money didn't stay with us.
const MP_LOST_STATUSES = ['refunded', 'charged_back', 'cancelled', 'rejected'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Accepts both "1.234,56" (pt-BR) and "1234.56".
function parseValor(raw) {
  let s = String(raw ?? '').trim().replace(/[R$\s]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, round2(n)) : 0;
}

function getContabilidade(db) {
  return { lancamentos: [], categoriasExtras: {}, ...(db.contabilidade || {}) };
}

// Default categories plus any the admin created ("+ Nova categoria").
function getCategorias(conta, setor) {
  const extras = conta.categoriasExtras?.[setor] || {};
  const merge = (base, extra) => {
    const outros = base.filter((c) => c !== 'Outros');
    return [...outros, ...(extra || []).filter((c) => !base.includes(c)), 'Outros'];
  };
  return {
    custo: merge(SETORES[setor].categoriasCusto, extras.custo),
    entrada: merge(SETORES[setor].categoriasEntrada, extras.entrada),
  };
}

// Pulls the real numbers for each order straight from Mercado Pago (net after
// fees, refunds, chargebacks) and caches them on the order as `order.mp`.
// Pending orders are checked too, to catch payments MP approved but whose
// webhook never reached us.
async function syncMercadoPago() {
  const db = store.load();
  const orders = Object.values(db.orders).filter(
    (o) => !o.isCourtesy && /^\d+$/.test(String(o.mpPaymentId || '')) && ['paid', 'pending'].includes(o.status)
  );

  const results = {};
  let falhas = 0;
  for (let i = 0; i < orders.length; i += 5) {
    await Promise.all(
      orders.slice(i, i + 5).map(async (o) => {
        try {
          const p = await mp.getPayment(o.mpPaymentId);
          const gross = round2(p.transaction_amount);
          const net = round2(p.transaction_details?.net_received_amount);
          const feeFromDetails = round2((p.fee_details || []).reduce((s, f) => s + (Number(f.amount) || 0), 0));
          results[o.id] = {
            status: p.status,
            statusDetail: p.status_detail || null,
            paymentType: p.payment_type_id || null,
            paymentMethod: p.payment_method_id || null,
            installments: p.installments || 1,
            gross,
            fee: feeFromDetails || (net > 0 ? round2(gross - net) : 0),
            net,
            refunded: round2(p.transaction_amount_refunded),
            releaseDate: p.money_release_date || null,
            syncedAt: new Date().toISOString(),
          };
        } catch (err) {
          falhas += 1;
          console.error(`[contabilidade] falha ao consultar pagamento ${o.mpPaymentId}:`, err.message);
        }
      })
    );
  }

  await store.withDb((d) => {
    Object.entries(results).forEach(([id, mpData]) => {
      if (d.orders[id]) d.orders[id].mp = mpData;
    });
    d.contabilidade = { ...getContabilidade(d), mpSyncedAt: new Date().toISOString() };
  });

  return { consultados: Object.keys(results).length, falhas };
}

// What actually landed in the MP account for this order.
function receivedFromMp(mpData) {
  if (MP_LOST_STATUSES.includes(mpData.status)) return 0;
  if (mpData.status !== 'approved') return 0;
  return round2(Math.max(0, mpData.net - mpData.refunded));
}

function sumLancamentos(lancs) {
  const bruto = round2(lancs.reduce((s, l) => s + l.valor, 0));
  const taxas = round2(lancs.reduce((s, l) => s + (l.taxa || 0), 0));
  return { bruto, taxas, liquido: round2(bruto - taxas) };
}

function splitLancamentos(conta, setor) {
  const doSetor = conta.lancamentos
    .filter((l) => l.setor === setor)
    .sort((a, b) => String(a.data).localeCompare(String(b.data)) || a.createdAt.localeCompare(b.createdAt));
  const entradas = doSetor.filter((l) => l.tipo === 'entrada');
  const custos = doSetor.filter((l) => l.tipo === 'custo');
  const totalCustos = round2(custos.reduce((s, l) => s + l.valor, 0));
  const custosAPagar = round2(custos.filter((l) => !l.pago).reduce((s, l) => s + l.valor, 0));
  const custosPorCategoria = {};
  custos.forEach((l) => {
    custosPorCategoria[l.categoria] = round2((custosPorCategoria[l.categoria] || 0) + l.valor);
  });
  return {
    entradas,
    custos,
    entradasManuais: sumLancamentos(entradas),
    totalCustos,
    custosAPagar,
    custosPorCategoria: Object.entries(custosPorCategoria)
      .map(([categoria, valor]) => ({ categoria, valor }))
      .sort((a, b) => b.valor - a.valor),
  };
}

function buildBilheteria(db, conta) {
  const orders = Object.values(db.orders);
  const tickets = Object.values(db.tickets);
  const paid = orders.filter((o) => o.status === 'paid' && !o.isCourtesy);

  const porLote = {};
  const porForma = {};
  const divergencias = [];
  const ingressos = { vendidos: 0, bruto: 0, taxas: 0, estornos: 0, recebidoMp: 0, naoSincronizado: 0, pedidosNaoSincronizados: 0 };

  paid.forEach((o) => {
    const lote = (porLote[o.loteName] = porLote[o.loteName] || {
      name: o.loteName, unitPrice: o.unitPrice, qty: 0, pedidos: 0, bruto: 0, taxas: 0, liquido: 0,
    });
    lote.qty += o.quantity;
    lote.pedidos += 1;
    lote.bruto += o.totalAmount;
    ingressos.vendidos += o.quantity;
    ingressos.bruto += o.totalAmount;

    if (!o.mp) {
      ingressos.naoSincronizado += o.totalAmount;
      ingressos.pedidosNaoSincronizados += 1;
      return;
    }

    const recebido = receivedFromMp(o.mp);
    const perdido = MP_LOST_STATUSES.includes(o.mp.status);
    lote.taxas += perdido ? 0 : o.mp.fee;
    lote.liquido += recebido;
    ingressos.taxas += perdido ? 0 : o.mp.fee;
    ingressos.estornos += perdido ? o.totalAmount : o.mp.refunded;
    ingressos.recebidoMp += recebido;

    const forma = o.mp.paymentType === 'bank_transfer' || o.mp.paymentMethod === 'pix'
      ? 'Pix'
      : o.mp.paymentType === 'credit_card' ? 'Cartão de crédito'
      : o.mp.paymentType === 'debit_card' ? 'Cartão de débito' : (o.mp.paymentType || 'Outro');
    const f = (porForma[forma] = porForma[forma] || { forma, pedidos: 0, bruto: 0, taxas: 0, liquido: 0 });
    f.pedidos += 1;
    f.bruto += o.totalAmount;
    f.taxas += perdido ? 0 : o.mp.fee;
    f.liquido += recebido;

    if (o.mp.status !== 'approved') {
      divergencias.push({ order: o, motivo: `Mercado Pago diz "${o.mp.status}" mas o pedido esta pago aqui (ingresso emitido).` });
    } else if (Math.abs(o.mp.gross - o.totalAmount) > 0.009) {
      divergencias.push({ order: o, motivo: `Valor no MP (R$ ${o.mp.gross.toFixed(2)}) diferente do pedido (R$ ${o.totalAmount.toFixed(2)}).` });
    } else if (o.mp.refunded > 0) {
      divergencias.push({ order: o, motivo: `Reembolso parcial de R$ ${o.mp.refunded.toFixed(2)} no MP.` });
    }
  });

  // Paid in MP but still pending here: webhook never arrived, buyer has no ticket.
  orders
    .filter((o) => o.status === 'pending' && o.mp && o.mp.status === 'approved')
    .forEach((o) => {
      divergencias.push({ order: o, motivo: 'Aprovado no Mercado Pago mas PENDENTE aqui — comprador pagou e nao recebeu ingresso.' });
    });

  Object.keys(ingressos).forEach((k) => { ingressos[k] = round2(ingressos[k]); });
  Object.values(porLote).forEach((l) => { l.bruto = round2(l.bruto); l.taxas = round2(l.taxas); l.liquido = round2(l.liquido); });
  Object.values(porForma).forEach((f) => { f.bruto = round2(f.bruto); f.taxas = round2(f.taxas); f.liquido = round2(f.liquido); });

  const courtesyOrderIds = new Set(orders.filter((o) => o.isCourtesy).map((o) => o.id));
  const cortesias = tickets.filter((t) => courtesyOrderIds.has(t.orderId)).length;
  const checkins = tickets.filter((t) => t.status === 'used').length;
  const checkinsCortesia = tickets.filter((t) => t.status === 'used' && courtesyOrderIds.has(t.orderId)).length;
  const pendentes = orders.filter((o) => o.status === 'pending').length;

  const manual = splitLancamentos(conta, 'bilheteria');

  // Until every order is synced, unsynced ones count at face value so the
  // balance isn't artificially low; the page flags that it's an estimate.
  const liquidoIngressos = round2(ingressos.recebidoMp + ingressos.naoSincronizado);
  const receitaTotal = round2(liquidoIngressos + manual.entradasManuais.liquido);
  const resultado = round2(receitaTotal - manual.totalCustos);
  const liquidoMedio = ingressos.vendidos ? liquidoIngressos / ingressos.vendidos : 0;
  const custosSemManual = Math.max(0, manual.totalCustos - manual.entradasManuais.liquido);
  const pontoEquilibrio = liquidoMedio > 0 ? Math.ceil(custosSemManual / liquidoMedio) : null;

  return {
    ...manual,
    ingressos,
    porLote: Object.values(porLote),
    porForma: Object.values(porForma),
    divergencias,
    cortesias,
    checkins,
    checkinsCortesia,
    pendentes,
    liquidoIngressos,
    receitaTotal,
    resultado,
    liquidoMedio: round2(liquidoMedio),
    pontoEquilibrio,
    estimado: ingressos.pedidosNaoSincronizados > 0,
  };
}

function buildBar(conta) {
  const manual = splitLancamentos(conta, 'bar');
  const receitaTotal = manual.entradasManuais.liquido;
  const resultado = round2(receitaTotal - manual.totalCustos);
  const porForma = {};
  manual.entradas.forEach((l) => {
    const f = (porForma[l.forma || 'Outro'] = porForma[l.forma || 'Outro'] || { forma: l.forma || 'Outro', bruto: 0, taxas: 0, liquido: 0 });
    f.bruto = round2(f.bruto + l.valor);
    f.taxas = round2(f.taxas + (l.taxa || 0));
    f.liquido = round2(f.bruto - f.taxas);
  });
  return {
    ...manual,
    porForma: Object.values(porForma),
    receitaTotal,
    resultado,
    margem: receitaTotal > 0 ? round2((resultado / receitaTotal) * 100) : null,
  };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvMoney = (n) => round2(n).toFixed(2).replace('.', ',');

function registerContabilidadeRoutes(app, { isAdmin, requireAdminAuth, eventInfo }) {
  app.get('/contabilidade', (req, res) => {
    if (!isAdmin(req)) {
      return res.render('admin_login', { eventInfo, error: null, next: '/contabilidade' });
    }
    const db = store.load();
    const conta = getContabilidade(db);
    const ver = ['bilheteria', 'bar'].includes(req.query.ver) ? req.query.ver : 'resumo';
    const editId = req.query.editar || null;

    res.render('admin_contabilidade', {
      eventInfo,
      ver,
      setores: SETORES,
      formas: FORMAS,
      bilheteria: buildBilheteria(db, conta),
      bar: buildBar(conta),
      mpSyncedAt: conta.mpSyncedAt || null,
      categorias: ver === 'resumo' ? null : getCategorias(conta, ver),
      editing: editId ? conta.lancamentos.find((l) => l.id === editId) || null : null,
      msg: req.query.msg || null,
    });
  });

  app.post('/api/contabilidade/lancamentos', requireAdminAuth, async (req, res) => {
    const setor = SETORES[req.body.setor] ? req.body.setor : null;
    const tipo = ['custo', 'entrada'].includes(req.body.tipo) ? req.body.tipo : null;
    const valor = parseValor(req.body.valor);
    if (!setor || !tipo || valor <= 0) {
      return res.redirect(`/contabilidade?ver=${setor || 'resumo'}&msg=invalido`);
    }

    const novaCategoria = String(req.body.categoriaNova || '').trim().replace(/s+/g, ' ').slice(0, 60);
    const fields = {
      setor,
      tipo,
      categoria: novaCategoria || String(req.body.categoria || 'Outros').trim().slice(0, 80),
      descricao: String(req.body.descricao || '').trim().slice(0, 200),
      valor,
      taxa: tipo === 'entrada' ? Math.min(parseValor(req.body.taxa), valor) : 0,
      forma: FORMAS.includes(req.body.forma) ? req.body.forma : null,
      pago: tipo === 'custo' ? req.body.pago === '1' : true,
      data: /^\d{4}-\d{2}-\d{2}$/.test(req.body.data || '') ? req.body.data : null,
      updatedAt: new Date().toISOString(),
    };

    await store.withDb((db) => {
      db.contabilidade = getContabilidade(db);
      if (novaCategoria && !getCategorias(db.contabilidade, setor)[tipo].includes(novaCategoria)) {
        const extras = (db.contabilidade.categoriasExtras[setor] = db.contabilidade.categoriasExtras[setor] || {});
        extras[tipo] = [...(extras[tipo] || []), novaCategoria];
      }
      const existing = req.body.id && db.contabilidade.lancamentos.find((l) => l.id === req.body.id);
      if (existing) Object.assign(existing, fields);
      else db.contabilidade.lancamentos.push({ id: crypto.randomUUID(), createdAt: fields.updatedAt, ...fields });
    });

    res.redirect(`/contabilidade?ver=${setor}&msg=salvo`);
  });

  app.post('/api/contabilidade/lancamentos/:id/excluir', requireAdminAuth, async (req, res) => {
    let setor = 'resumo';
    await store.withDb((db) => {
      db.contabilidade = getContabilidade(db);
      const l = db.contabilidade.lancamentos.find((x) => x.id === req.params.id);
      if (l) setor = l.setor;
      db.contabilidade.lancamentos = db.contabilidade.lancamentos.filter((x) => x.id !== req.params.id);
    });
    res.redirect(`/contabilidade?ver=${setor}&msg=excluido`);
  });

  app.post('/api/contabilidade/lancamentos/:id/pago', requireAdminAuth, async (req, res) => {
    let setor = 'resumo';
    await store.withDb((db) => {
      db.contabilidade = getContabilidade(db);
      const l = db.contabilidade.lancamentos.find((x) => x.id === req.params.id);
      if (l && l.tipo === 'custo') {
        l.pago = !l.pago;
        setor = l.setor;
      }
    });
    res.redirect(`/contabilidade?ver=${setor}`);
  });

  app.post('/api/contabilidade/sincronizar-mp', requireAdminAuth, async (req, res) => {
    try {
      const { consultados, falhas } = await syncMercadoPago();
      res.redirect(`/contabilidade?ver=bilheteria&msg=${falhas ? `sync-parcial-${consultados}-${falhas}` : `sync-ok-${consultados}`}`);
    } catch (err) {
      console.error('[contabilidade] sincronizacao MP falhou:', err.message);
      res.redirect('/contabilidade?ver=bilheteria&msg=sync-erro');
    }
  });

  // Excel-friendly CSV (";" separator, comma decimals, UTF-8 BOM).
  app.get('/contabilidade/exportar.csv', requireAdminAuth, (req, res) => {
    const db = store.load();
    const conta = getContabilidade(db);
    const rows = [['Setor', 'Tipo', 'Data', 'Categoria', 'Descricao', 'Forma', 'Valor bruto', 'Taxa', 'Valor liquido', 'Status']];

    conta.lancamentos.forEach((l) => {
      rows.push([
        SETORES[l.setor]?.label || l.setor, l.tipo === 'custo' ? 'Custo' : 'Entrada', l.data || '', l.categoria, l.descricao,
        l.forma || '', csvMoney(l.valor), csvMoney(l.taxa || 0), csvMoney(l.valor - (l.taxa || 0)),
        l.tipo === 'custo' ? (l.pago ? 'Pago' : 'A pagar') : 'Recebido',
      ]);
    });

    Object.values(db.orders)
      .filter((o) => o.status === 'paid' && !o.isCourtesy)
      .forEach((o) => {
        const net = o.mp ? receivedFromMp(o.mp) : o.totalAmount;
        rows.push([
          'Bilheteria', 'Ingresso online', o.createdAt.slice(0, 10), o.loteName, `${o.quantity}x ingresso - ${o.buyerName}`,
          o.mp?.paymentType || o.paymentMethodId || '', csvMoney(o.totalAmount), csvMoney(round2(o.totalAmount - net)), csvMoney(net),
          o.mp ? `MP: ${o.mp.status}` : 'MP nao sincronizado',
        ]);
      });

    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="bordero-crewolada.csv"');
    res.send(csv);
  });
}

module.exports = { registerContabilidadeRoutes, syncMercadoPago, parseValor };
