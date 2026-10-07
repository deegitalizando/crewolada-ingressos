const crypto = require('crypto');
const store = require('./store');
const mp = require('./mercadopago');

// Borderô do evento. Receitas vêm de dois setores (bilheteria e bar); as
// despesas de cada setor são classificadas em fixas (não mudam com o público:
// salão, som, atrações) ou variáveis (crescem com o público: bebidas, gelo,
// pulseiras). Cada despesa guarda quanto já foi pago, pra saber o que falta.
const SETORES = { bilheteria: 'Bilheteria', bar: 'Bar' };
const NATUREZAS = { fixa: 'Fixa', variavel: 'Variável' };

// [categoria, natureza sugerida] — the admin can still override per entry.
const CATEGORIAS_DESPESA = {
  bilheteria: [
    ['Salão / locação do espaço', 'fixa'], ['Som', 'fixa'], ['Iluminação', 'fixa'], ['Palco e estrutura', 'fixa'],
    ['Camarim', 'fixa'], ['Atrações / artistas', 'fixa'], ['DJs', 'fixa'], ['Apresentador / MC', 'fixa'],
    ['Segurança', 'fixa'], ['Bombeiro / brigada', 'fixa'], ['Recepção / portaria', 'fixa'], ['Limpeza', 'fixa'],
    ['Equipe de produção', 'fixa'], ['Decoração', 'fixa'], ['Gerador / energia', 'fixa'], ['Fotografia e vídeo', 'fixa'],
    ['Divulgação / anúncios', 'fixa'], ['Alimentação da equipe', 'fixa'], ['Transporte / frete', 'fixa'],
    ['Hospedagem', 'fixa'], ['Impressos / pulseiras', 'variavel'], ['Taxas e licenças (ECAD, alvará)', 'variavel'],
  ],
  bar: [
    ['Bebidas', 'variavel'], ['Gelo', 'variavel'], ['Descartáveis (copos, canudos)', 'variavel'],
    ['Comida / insumos', 'variavel'], ['Taxa da maquininha', 'variavel'], ['Equipe do bar', 'fixa'],
    ['Aluguel de freezer / equipamento', 'fixa'],
  ],
};

const CATEGORIAS_RECEITA = {
  bilheteria: ['Venda na porta', 'Patrocínio', 'Apoio / permuta', 'Lista / promoter', 'Estacionamento'],
  bar: ['Fechamento de caixa', 'Maquininha', 'Pix', 'Dinheiro', 'Fichas / consumação'],
};

const FORMAS = ['Pix', 'Dinheiro', 'Cartão de débito', 'Cartão de crédito', 'Transferência', 'Outro'];

// MP statuses where the money didn't stay with us.
const MP_LOST_STATUSES = ['refunded', 'charged_back', 'cancelled', 'rejected'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (list, fn) => round2(list.reduce((s, x) => s + (Number(fn(x)) || 0), 0));

// Accepts both "1.234,56" (pt-BR) and "1234.56".
function parseValor(raw) {
  let s = String(raw ?? '').trim().replace(/[R$\s]/g, '');
  if (!s) return 0;
  // "1.500" with no comma is pt-BR thousands, not 1.5.
  if (s.includes(',') || /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, round2(n)) : 0;
}

function naturezaSugerida(setor, categoria) {
  const found = (CATEGORIAS_DESPESA[setor] || []).find(([c]) => c === categoria);
  return found ? found[1] : 'variavel';
}

// Entries saved by the first version of the borderô used tipo custo/entrada
// and a boolean `pago`; read them as the current shape.
function normalizeLancamento(l) {
  const tipo = l.tipo === 'custo' ? 'despesa' : l.tipo === 'entrada' ? 'receita' : l.tipo;
  const out = { ...l, tipo };
  if (tipo === 'despesa') {
    out.natureza = NATUREZAS[l.natureza] ? l.natureza : naturezaSugerida(l.setor, l.categoria);
    out.valorPago = round2(Math.min(l.valor, l.valorPago ?? (l.pago ? l.valor : 0)));
    out.faltaPagar = round2(l.valor - out.valorPago);
    out.status = out.faltaPagar <= 0 ? 'pago' : out.valorPago > 0 ? 'parcial' : 'aberto';
    delete out.pago;
  } else {
    out.taxa = round2(l.taxa || 0);
    out.liquido = round2(l.valor - out.taxa);
  }
  return out;
}

function getContabilidade(db) {
  const conta = { lancamentos: [], categoriasExtras: {}, ...(db.contabilidade || {}) };
  return { ...conta, lancamentos: conta.lancamentos.map(normalizeLancamento) };
}

// Default categories plus any the admin created ("+ Nova categoria").
function getCategorias(conta) {
  const out = { despesa: {}, receita: {} };
  Object.keys(SETORES).forEach((setor) => {
    const extras = conta.categoriasExtras?.[setor] || {};
    const extraDespesa = [...(extras.despesa || []), ...(extras.custo || [])];
    const extraReceita = [...(extras.receita || []), ...(extras.entrada || [])];
    const baseDespesa = CATEGORIAS_DESPESA[setor].map(([c, n]) => ({ nome: c, natureza: n }));
    out.despesa[setor] = [
      ...baseDespesa,
      ...extraDespesa.filter((c) => !baseDespesa.some((b) => b.nome === c)).map((c) => ({ nome: c, natureza: null })),
      { nome: 'Outros', natureza: null },
    ];
    out.receita[setor] = [...new Set([...CATEGORIAS_RECEITA[setor], ...extraReceita])].concat('Outros');
  });
  return out;
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
          const feeFromDetails = sum(p.fee_details || [], (f) => f.amount);
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
    d.contabilidade = { ...(d.contabilidade || {}), mpSyncedAt: new Date().toISOString() };
  });

  return { consultados: Object.keys(results).length, falhas };
}

// What actually landed in the MP account for this order.
function receivedFromMp(mpData) {
  if (mpData.status !== 'approved') return 0;
  return round2(Math.max(0, mpData.net - mpData.refunded));
}

function paymentLabel(mpData) {
  if (mpData.paymentType === 'bank_transfer' || mpData.paymentMethod === 'pix') return 'Pix';
  if (mpData.paymentType === 'credit_card') return 'Cartão de crédito';
  if (mpData.paymentType === 'debit_card') return 'Cartão de débito';
  return mpData.paymentType || 'Outro';
}

// Online ticket sales, crossed with what Mercado Pago actually paid out.
function buildIngressos(db) {
  const orders = Object.values(db.orders);
  const tickets = Object.values(db.tickets);
  const paid = orders.filter((o) => o.status === 'paid' && !o.isCourtesy);

  const porLote = {};
  const porForma = {};
  const divergencias = [];
  const t = { vendidos: 0, bruto: 0, taxas: 0, estornos: 0, recebidoMp: 0, naoSincronizado: 0, pedidosNaoSincronizados: 0 };

  paid.forEach((o) => {
    const lote = (porLote[o.loteName] = porLote[o.loteName] || {
      name: o.loteName, unitPrice: o.unitPrice, qty: 0, pedidos: 0, bruto: 0, taxas: 0, liquido: 0,
    });
    lote.qty += o.quantity;
    lote.pedidos += 1;
    lote.bruto += o.totalAmount;
    t.vendidos += o.quantity;
    t.bruto += o.totalAmount;

    if (!o.mp) {
      t.naoSincronizado += o.totalAmount;
      t.pedidosNaoSincronizados += 1;
      return;
    }

    const recebido = receivedFromMp(o.mp);
    const perdido = MP_LOST_STATUSES.includes(o.mp.status);
    const fee = perdido ? 0 : o.mp.fee;
    lote.taxas += fee;
    lote.liquido += recebido;
    t.taxas += fee;
    t.estornos += perdido ? o.totalAmount : o.mp.refunded;
    t.recebidoMp += recebido;

    const forma = paymentLabel(o.mp);
    const f = (porForma[forma] = porForma[forma] || { forma, pedidos: 0, bruto: 0, taxas: 0, liquido: 0 });
    f.pedidos += 1;
    f.bruto += o.totalAmount;
    f.taxas += fee;
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

  Object.keys(t).forEach((k) => { t[k] = round2(t[k]); });
  [...Object.values(porLote), ...Object.values(porForma)].forEach((x) => {
    x.bruto = round2(x.bruto); x.taxas = round2(x.taxas); x.liquido = round2(x.liquido);
  });

  const courtesyOrderIds = new Set(orders.filter((o) => o.isCourtesy).map((o) => o.id));

  // Until every order is synced, unsynced ones count at face value so the
  // balance isn't artificially low; the page flags that it's an estimate.
  const liquido = round2(t.recebidoMp + t.naoSincronizado);
  return {
    ...t,
    liquido,
    liquidoMedio: t.vendidos ? round2(liquido / t.vendidos) : 0,
    estimado: t.pedidosNaoSincronizados > 0,
    porLote: Object.values(porLote),
    porForma: Object.values(porForma),
    divergencias,
    cortesias: tickets.filter((x) => courtesyOrderIds.has(x.orderId)).length,
    checkins: tickets.filter((x) => x.status === 'used').length,
    checkinsCortesia: tickets.filter((x) => x.status === 'used' && courtesyOrderIds.has(x.orderId)).length,
    pendentes: orders.filter((o) => o.status === 'pending').length,
  };
}

function totaisDespesas(list) {
  return { total: sum(list, (l) => l.valor), pago: sum(list, (l) => l.valorPago), falta: sum(list, (l) => l.faltaPagar) };
}

function buildBordero(db, conta) {
  const sortByDate = (a, b) => String(a.data || '').localeCompare(String(b.data || '')) || a.createdAt.localeCompare(b.createdAt);
  const receitas = conta.lancamentos.filter((l) => l.tipo === 'receita').sort(sortByDate);
  const despesas = conta.lancamentos.filter((l) => l.tipo === 'despesa').sort(sortByDate);
  const ingressos = buildIngressos(db);

  const setores = {};
  Object.keys(SETORES).forEach((setor) => {
    const rec = receitas.filter((l) => l.setor === setor);
    const desp = despesas.filter((l) => l.setor === setor);
    const receitaManual = sum(rec, (l) => l.liquido);
    const receita = round2(receitaManual + (setor === 'bilheteria' ? ingressos.liquido : 0));
    const fixas = totaisDespesas(desp.filter((l) => l.natureza === 'fixa'));
    const variaveis = totaisDespesas(desp.filter((l) => l.natureza === 'variavel'));
    const despesasTotal = round2(fixas.total + variaveis.total);
    setores[setor] = {
      label: SETORES[setor],
      receitaManual,
      receitaBruta: round2(sum(rec, (l) => l.valor) + (setor === 'bilheteria' ? ingressos.bruto : 0)),
      taxas: round2(sum(rec, (l) => l.taxa) + (setor === 'bilheteria' ? ingressos.taxas : 0)),
      receita,
      fixas,
      variaveis,
      despesas: despesasTotal,
      resultado: round2(receita - despesasTotal),
    };
  });

  const fixas = totaisDespesas(despesas.filter((l) => l.natureza === 'fixa'));
  const variaveis = totaisDespesas(despesas.filter((l) => l.natureza === 'variavel'));
  const receitaTotal = round2(setores.bilheteria.receita + setores.bar.receita);
  const despesaTotal = round2(fixas.total + variaveis.total);
  const pagoTotal = round2(fixas.pago + variaveis.pago);

  // Break-even in tickets: what fixed + variable costs the bar doesn't
  // already cover, divided by the average net ticket.
  const aCobrir = Math.max(0, despesaTotal - setores.bar.receita - setores.bilheteria.receitaManual);
  const pontoEquilibrio = ingressos.liquidoMedio > 0 ? Math.ceil(aCobrir / ingressos.liquidoMedio) : null;

  return {
    receitas,
    despesas,
    ingressos,
    setores,
    fixas,
    variaveis,
    receitaTotal,
    despesaTotal,
    pagoTotal,
    faltaPagar: round2(despesaTotal - pagoTotal),
    resultado: round2(receitaTotal - despesaTotal),
    saldoCaixa: round2(receitaTotal - pagoTotal),
    pontoEquilibrio,
  };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvMoney = (n) => round2(n).toFixed(2).replace('.', ',');

function redirectBack(res, ver, msg) {
  res.redirect(`/contabilidade?ver=${ver}${msg ? `&msg=${msg}` : ''}`);
}

function registerContabilidadeRoutes(app, { isAdmin, requireAdminAuth, eventInfo }) {
  app.get('/contabilidade', (req, res) => {
    if (!isAdmin(req)) {
      return res.render('admin_login', { eventInfo, error: null, next: '/contabilidade' });
    }
    const db = store.load();
    const conta = getContabilidade(db);
    const legacy = { bilheteria: 'receitas', bar: 'receitas' };
    const ver = ['receitas', 'despesas'].includes(req.query.ver) ? req.query.ver : legacy[req.query.ver] || 'resumo';
    const editing = req.query.editar ? conta.lancamentos.find((l) => l.id === req.query.editar) || null : null;

    res.render('admin_contabilidade', {
      eventInfo,
      ver,
      setores: SETORES,
      naturezas: NATUREZAS,
      formas: FORMAS,
      categorias: getCategorias(conta),
      b: buildBordero(db, conta),
      mpSyncedAt: conta.mpSyncedAt || null,
      editing,
      msg: req.query.msg || null,
    });
  });

  app.post('/api/contabilidade/lancamentos', requireAdminAuth, async (req, res) => {
    const tipo = ['despesa', 'receita'].includes(req.body.tipo) ? req.body.tipo : null;
    const ver = tipo === 'receita' ? 'receitas' : 'despesas';
    const setor = SETORES[req.body.setor] ? req.body.setor : null;
    const valor = parseValor(req.body.valor);
    if (!tipo || !setor || valor <= 0) return redirectBack(res, tipo ? ver : 'resumo', 'invalido');

    const novaCategoria = String(req.body.categoriaNova || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const categoria = novaCategoria || String(req.body.categoria || 'Outros').trim().slice(0, 80);
    const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

    const fields = {
      tipo,
      setor,
      categoria,
      descricao: String(req.body.descricao || '').trim().slice(0, 200),
      valor,
      forma: FORMAS.includes(req.body.forma) ? req.body.forma : null,
      data: data(req.body.data),
      updatedAt: new Date().toISOString(),
    };
    if (tipo === 'despesa') {
      fields.natureza = NATUREZAS[req.body.natureza] ? req.body.natureza : naturezaSugerida(setor, categoria);
      fields.valorPago = req.body.quitado === '1' ? valor : Math.min(parseValor(req.body.valorPago), valor);
      fields.vencimento = fields.valorPago < valor ? data(req.body.vencimento) : null;
    } else {
      fields.taxa = Math.min(parseValor(req.body.taxa), valor);
    }

    await store.withDb((db) => {
      db.contabilidade = { lancamentos: [], categoriasExtras: {}, ...(db.contabilidade || {}) };
      const conta = db.contabilidade;
      const existentes = getCategorias(conta)[tipo][setor].map((c) => (typeof c === 'string' ? c : c.nome));
      if (novaCategoria && !existentes.includes(novaCategoria)) {
        const extras = (conta.categoriasExtras[setor] = conta.categoriasExtras[setor] || {});
        extras[tipo] = [...(extras[tipo] || []), novaCategoria];
      }
      const existing = req.body.id && conta.lancamentos.find((l) => l.id === req.body.id);
      if (existing) {
        Object.keys(existing).forEach((k) => { if (!['id', 'createdAt'].includes(k)) delete existing[k]; });
        Object.assign(existing, fields);
      } else {
        conta.lancamentos.push({ id: crypto.randomUUID(), createdAt: fields.updatedAt, ...fields });
      }
    });

    redirectBack(res, ver, 'salvo');
  });

  app.post('/api/contabilidade/lancamentos/:id/excluir', requireAdminAuth, async (req, res) => {
    let ver = 'resumo';
    await store.withDb((db) => {
      const conta = db.contabilidade || { lancamentos: [] };
      const l = conta.lancamentos.find((x) => x.id === req.params.id);
      if (l) ver = ['receita', 'entrada'].includes(l.tipo) ? 'receitas' : 'despesas';
      conta.lancamentos = conta.lancamentos.filter((x) => x.id !== req.params.id);
    });
    redirectBack(res, ver, 'excluido');
  });

  // Pays off whatever is still owed on an expense.
  app.post('/api/contabilidade/lancamentos/:id/quitar', requireAdminAuth, async (req, res) => {
    await store.withDb((db) => {
      const l = (db.contabilidade?.lancamentos || []).find((x) => x.id === req.params.id);
      if (l && ['despesa', 'custo'].includes(l.tipo)) {
        l.valorPago = l.valor;
        l.vencimento = null;
        delete l.pago;
      }
    });
    redirectBack(res, 'despesas', 'quitado');
  });

  app.post('/api/contabilidade/sincronizar-mp', requireAdminAuth, async (req, res) => {
    try {
      const { consultados, falhas } = await syncMercadoPago();
      redirectBack(res, 'receitas', falhas ? `sync-parcial-${consultados}-${falhas}` : `sync-ok-${consultados}`);
    } catch (err) {
      console.error('[contabilidade] sincronizacao MP falhou:', err.message);
      redirectBack(res, 'receitas', 'sync-erro');
    }
  });

  // Excel-friendly CSV (";" separator, comma decimals, UTF-8 BOM).
  app.get('/contabilidade/exportar.csv', requireAdminAuth, (req, res) => {
    const db = store.load();
    const conta = getContabilidade(db);
    const rows = [[
      'Tipo', 'Setor', 'Natureza', 'Data', 'Vencimento', 'Categoria', 'Descricao', 'Forma',
      'Valor', 'Taxa', 'Liquido', 'Valor pago', 'Falta pagar', 'Status',
    ]];
    const statusLabel = { pago: 'Pago', parcial: 'Pago parcialmente', aberto: 'A pagar' };

    conta.lancamentos.forEach((l) => {
      const despesa = l.tipo === 'despesa';
      rows.push([
        despesa ? 'Despesa' : 'Receita', SETORES[l.setor] || l.setor, despesa ? NATUREZAS[l.natureza] : '',
        l.data || '', l.vencimento || '', l.categoria, l.descricao, l.forma || '', csvMoney(l.valor),
        despesa ? '' : csvMoney(l.taxa), despesa ? '' : csvMoney(l.liquido),
        despesa ? csvMoney(l.valorPago) : '', despesa ? csvMoney(l.faltaPagar) : '',
        despesa ? statusLabel[l.status] : 'Recebido',
      ]);
    });

    Object.values(db.orders)
      .filter((o) => o.status === 'paid' && !o.isCourtesy)
      .forEach((o) => {
        const net = o.mp ? receivedFromMp(o.mp) : o.totalAmount;
        rows.push([
          'Receita', 'Bilheteria', '', o.createdAt.slice(0, 10), '', `Ingresso online - ${o.loteName}`,
          `${o.quantity}x ingresso - ${o.buyerName}`, o.mp ? paymentLabel(o.mp) : '', csvMoney(o.totalAmount),
          csvMoney(o.totalAmount - net), csvMoney(net), '', '', o.mp ? `MP: ${o.mp.status}` : 'MP nao conferido',
        ]);
      });

    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="bordero-crewolada.csv"');
    res.send(csv);
  });
}

module.exports = { registerContabilidadeRoutes, syncMercadoPago, parseValor };
