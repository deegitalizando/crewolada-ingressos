const store = require('./store');
const { getLotes } = require('./lotes');

// Brasilia has had no DST since 2019, so a fixed -3h shift is exact.
const BRT_MS = 3 * 60 * 60 * 1000;
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WEEKDAYS_PLURAL = ['aos domingos', 'às segundas', 'às terças', 'às quartas', 'às quintas', 'às sextas', 'aos sábados'];
const plural = (n, one, many) => (n === 1 ? one : many);

const DDD_UF = {
  11: 'SP', 12: 'SP', 13: 'SP', 14: 'SP', 15: 'SP', 16: 'SP', 17: 'SP', 18: 'SP', 19: 'SP',
  21: 'RJ', 22: 'RJ', 24: 'RJ', 27: 'ES', 28: 'ES',
  31: 'MG', 32: 'MG', 33: 'MG', 34: 'MG', 35: 'MG', 37: 'MG', 38: 'MG',
  41: 'PR', 42: 'PR', 43: 'PR', 44: 'PR', 45: 'PR', 46: 'PR', 47: 'SC', 48: 'SC', 49: 'SC',
  51: 'RS', 53: 'RS', 54: 'RS', 55: 'RS',
  61: 'DF', 62: 'GO', 63: 'TO', 64: 'GO', 65: 'MT', 66: 'MT', 67: 'MS', 68: 'AC', 69: 'RO',
  71: 'BA', 73: 'BA', 74: 'BA', 75: 'BA', 77: 'BA', 79: 'SE',
  81: 'PE', 82: 'AL', 83: 'PB', 84: 'RN', 85: 'CE', 86: 'PI', 87: 'PE', 88: 'CE', 89: 'PI',
  91: 'PA', 92: 'AM', 93: 'PA', 94: 'PA', 95: 'RR', 96: 'AP', 97: 'AM', 98: 'MA', 99: 'MA',
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (part, total) => (total > 0 ? (part / total) * 100 : 0);
const fmtPct = (n) => `${(Math.round(n * 10) / 10).toString().replace('.', ',')}%`;
const fmtBrl = (n) => `R$ ${round2(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function brt(iso) {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return null;
  const d = new Date(t - BRT_MS);
  return {
    ts: t,
    key: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    dow: d.getUTCDay(),
    slot: d.toISOString().slice(0, 13), // yyyy-mm-ddThh
  };
}

function dayLabel(key) {
  const [, m, d] = key.split('-');
  return `${d}/${m}`;
}

function dayDiff(keyA, keyB) {
  return Math.round((Date.parse(`${keyB}T00:00:00Z`) - Date.parse(`${keyA}T00:00:00Z`)) / 86400000);
}

function addDays(key, n) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function eventStart(db, eventInfo) {
  if (db.eventStartAt && !Number.isNaN(new Date(db.eventStartAt).getTime())) return new Date(db.eventStartAt).toISOString();
  const m = String(eventInfo.dateLabel || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T22:00:00-03:00`).toISOString();
  return null;
}

function dddOf(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d.length >= 10 ? Number(d.slice(0, 2)) : null;
}

function buildReport(db, eventInfo) {
  const orders = Object.values(db.orders || {});
  const tickets = Object.values(db.tickets || {});
  const lotes = getLotes(db);
  const orderById = db.orders || {};
  const startIso = eventStart(db, eventInfo);
  const startBrt = startIso ? brt(startIso) : null;

  // ---- populations -------------------------------------------------
  const saleOrders = orders.filter((o) => !o.isCourtesy && (o.status === 'paid' || o.status === 'cancelled'));
  const paidOrders = saleOrders.filter((o) => o.status === 'paid');
  const cancelledOrders = saleOrders.filter((o) => o.status === 'cancelled');
  const courtesyOrders = orders.filter((o) => o.isCourtesy && o.status === 'paid');
  const otherOrders = orders.filter((o) => !o.isCourtesy);
  const pendingOrders = otherOrders.filter((o) => o.status === 'pending');
  const rejectedOrders = otherOrders.filter((o) => o.status === 'rejected');

  const ticketsOf = (o) => tickets.filter((t) => t.orderId === o.id);
  const paidTickets = tickets.filter((t) => {
    const o = orderById[t.orderId];
    return o && !o.isCourtesy && o.status === 'paid' && t.status !== 'cancelled';
  });
  const courtesyTickets = tickets.filter((t) => {
    const o = orderById[t.orderId];
    return o && o.isCourtesy && o.status === 'paid' && t.status !== 'cancelled';
  });
  const usedPaid = paidTickets.filter((t) => t.status === 'used');
  const usedCourtesy = courtesyTickets.filter((t) => t.status === 'used');
  const validTickets = paidTickets.length + courtesyTickets.length;
  const attended = usedPaid.length + usedCourtesy.length;
  const noShow = validTickets - attended;

  // ---- money -------------------------------------------------------
  const gross = paidOrders.reduce((s, o) => s + o.totalAmount, 0);
  let fees = 0;
  let netSynced = 0;
  let unsyncedFace = 0;
  let unsyncedCount = 0;
  paidOrders.forEach((o) => {
    if (o.mp && o.mp.status === 'approved') {
      fees += Number(o.mp.fee || 0);
      netSynced += Math.max(0, Number(o.mp.net || 0) - Number(o.mp.refunded || 0));
    } else if (!o.mp) {
      unsyncedFace += o.totalAmount;
      unsyncedCount += 1;
    }
  });
  const refunded = cancelledOrders.reduce((s, o) => s + (o.refund ? Number(o.refund.amount || 0) : 0), 0);
  const net = netSynced + unsyncedFace;

  // ---- lotes (stock order = creation order of sales) ---------------
  const stockTickets = tickets
    .map((t) => ({ t, o: orderById[t.orderId] }))
    .filter(({ o }) => o && !o.isCourtesy && o.loteName !== 'Lote Teste' && (o.status === 'paid' || o.status === 'cancelled'))
    .sort((a, b) => new Date(a.o.createdAt) - new Date(b.o.createdAt));

  const loteRows = [];
  let floor = 0;
  lotes.forEach((l) => {
    const slice = stockTickets.slice(floor, floor + l.quantity);
    floor += l.quantity;
    const first = slice[0] ? brt(slice[0].o.createdAt) : null;
    const last = slice[slice.length - 1] ? brt(slice[slice.length - 1].o.createdAt) : null;
    const used = slice.filter(({ t }) => t.status === 'used').length;
    const valid = slice.filter(({ t }) => t.status !== 'cancelled').length;
    loteRows.push({
      name: l.name,
      price: l.price,
      capacity: l.quantity,
      sold: slice.length,
      valid,
      used,
      attendance: pct(used, valid),
      revenue: round2(slice.filter(({ t, o }) => o.status === 'paid' && t.status !== 'cancelled').length * l.price),
      soldOut: slice.length >= l.quantity,
      firstDay: first ? first.key : null,
      lastDay: last ? last.key : null,
      daysToSell: first && last ? dayDiff(first.key, last.key) + 1 : 0,
    });
  });
  const testTickets = tickets.filter((t) => {
    const o = orderById[t.orderId];
    return o && !o.isCourtesy && o.loteName === 'Lote Teste' && o.status === 'paid';
  });
  if (testTickets.length) {
    loteRows.push({
      name: 'Lote Teste', price: 0, capacity: testTickets.length, sold: testTickets.length, valid: testTickets.length,
      used: testTickets.filter((t) => t.status === 'used').length, attendance: 0, revenue: 0, soldOut: true,
      firstDay: null, lastDay: null, daysToSell: 0, isTest: true,
    });
  }

  // ---- sales per day, stacked by lote -------------------------------
  const loteOf = (o) => o.loteName || 'Sem lote';
  const dayMap = {};
  paidTickets.forEach((t) => {
    const o = orderById[t.orderId];
    const b = brt(o.createdAt);
    if (!b) return;
    dayMap[b.key] = dayMap[b.key] || {};
    dayMap[b.key][loteOf(o)] = (dayMap[b.key][loteOf(o)] || 0) + 1;
  });
  const dayKeys = Object.keys(dayMap).sort();
  const days = [];
  if (dayKeys.length) {
    const lastKey = startBrt && startBrt.key > dayKeys[dayKeys.length - 1] ? startBrt.key : dayKeys[dayKeys.length - 1];
    for (let k = dayKeys[0]; k <= lastKey; k = addDays(k, 1)) days.push(k);
  }
  const loteNames = [...new Set([...lotes.map((l) => l.name), ...paidTickets.map((t) => loteOf(orderById[t.orderId]))])]
    .filter((n) => paidTickets.some((t) => loteOf(orderById[t.orderId]) === n));
  const dailySeries = loteNames.map((n) => ({ name: n, values: days.map((k) => (dayMap[k] && dayMap[k][n]) || 0) }));
  const dailyTotals = days.map((_, i) => dailySeries.reduce((s, x) => s + x.values[i], 0));
  let run = 0;
  const cumulative = dailyTotals.map((v) => (run += v));

  // ---- hour / weekday of purchase ------------------------------------
  const hourBuy = Array(24).fill(0);
  const dowBuy = Array(7).fill(0);
  paidTickets.forEach((t) => {
    const b = brt(orderById[t.orderId].createdAt);
    if (!b) return;
    hourBuy[b.hour] += 1;
    dowBuy[b.dow] += 1;
  });

  // ---- lead time (days before the event) -----------------------------
  const leadBins = [
    { label: 'No dia', test: (d) => d <= 0 },
    { label: '1-2 dias', test: (d) => d >= 1 && d <= 2 },
    { label: '3-7 dias', test: (d) => d >= 3 && d <= 7 },
    { label: '8-14 dias', test: (d) => d >= 8 && d <= 14 },
    { label: '15-30 dias', test: (d) => d >= 15 && d <= 30 },
    { label: '31+ dias', test: (d) => d >= 31 },
  ];
  const leadCounts = leadBins.map(() => 0);
  if (startBrt) {
    paidTickets.forEach((t) => {
      const b = brt(orderById[t.orderId].createdAt);
      if (!b) return;
      const d = dayDiff(b.key, startBrt.key);
      const i = leadBins.findIndex((x) => x.test(d));
      if (i >= 0) leadCounts[i] += 1;
    });
  }

  // ---- order size, buyers, payment -----------------------------------
  const sizeMap = {};
  paidOrders.forEach((o) => { sizeMap[o.quantity] = (sizeMap[o.quantity] || 0) + 1; });
  const sizeKeys = Object.keys(sizeMap).map(Number).sort((a, b) => a - b);

  const cpfCount = {};
  paidOrders.forEach((o) => {
    const k = String(o.buyerCpf || '').replace(/\D/g, '') || String(o.buyerEmail || '').toLowerCase();
    if (k) cpfCount[k] = (cpfCount[k] || 0) + 1;
  });
  const buyers = Object.keys(cpfCount).length;
  const repeatBuyers = Object.values(cpfCount).filter((n) => n > 1).length;

  const pay = { Pix: { orders: 0, tickets: 0, gross: 0, fee: 0 }, Cartão: { orders: 0, tickets: 0, gross: 0, fee: 0 } };
  paidOrders.forEach((o) => {
    const k = String(o.paymentMethodId || '').toLowerCase() === 'pix' ? 'Pix' : 'Cartão';
    pay[k].orders += 1;
    pay[k].tickets += o.quantity;
    pay[k].gross += o.totalAmount;
    if (o.mp && o.mp.status === 'approved') pay[k].fee += Number(o.mp.fee || 0);
  });

  // ---- geography -------------------------------------------------------
  const dddMap = {};
  const ufMap = {};
  paidTickets.forEach((t) => {
    const ddd = dddOf(orderById[t.orderId].buyerPhone);
    if (ddd == null) return;
    const uf = DDD_UF[ddd] || '??';
    dddMap[ddd] = (dddMap[ddd] || 0) + 1;
    ufMap[uf] = (ufMap[uf] || 0) + 1;
  });
  const dddSorted = Object.entries(dddMap).sort((a, b) => b[1] - a[1]);
  const topDdd = dddSorted.slice(0, 8);
  const geoTotal = Object.values(dddMap).reduce((s, n) => s + n, 0);

  // ---- arrival (check-in) ----------------------------------------------
  const slotMap = {};
  [...usedPaid, ...usedCourtesy].forEach((t) => {
    const b = brt(t.usedAt);
    if (!b) return;
    slotMap[b.slot] = (slotMap[b.slot] || 0) + 1;
  });
  const slotKeys = Object.keys(slotMap).sort();
  const arrival = [];
  if (slotKeys.length) {
    for (let ts = Date.parse(`${slotKeys[0]}:00:00Z`); ts <= Date.parse(`${slotKeys[slotKeys.length - 1]}:00:00Z`); ts += 3600000) {
      const key = new Date(ts).toISOString().slice(0, 13);
      arrival.push({ label: `${key.slice(11, 13)}h`, day: key.slice(0, 10), value: slotMap[key] || 0 });
    }
  }

  // ---- participants registered -------------------------------------------
  const multi = paidOrders.filter((o) => o.quantity > 1);
  const multiTickets = multi.flatMap((o) => ticketsOf(o)).filter((t) => t.status !== 'cancelled');
  const named = multiTickets.filter((t) => t.participantName).length;

  // ---- derived headline numbers -------------------------------------------
  const ticketsSold = paidTickets.length;
  const avgTicket = ticketsSold ? gross / ticketsSold : 0;
  const peakBuyHour = hourBuy.indexOf(Math.max(...hourBuy));
  const peakDow = dowBuy.indexOf(Math.max(...dowBuy));
  const lastWeekShare = pct(leadCounts[0] + leadCounts[1] + leadCounts[2], leadCounts.reduce((s, n) => s + n, 0));
  const lastDaysShare = pct(leadCounts[0] + leadCounts[1], leadCounts.reduce((s, n) => s + n, 0));
  const peakArrival = arrival.length ? arrival.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const paidAttendance = pct(usedPaid.length, paidTickets.length);
  const courtesyAttendance = pct(usedCourtesy.length, courtesyTickets.length);
  const conversionBase = paidOrders.length + cancelledOrders.length + pendingOrders.length + rejectedOrders.length;
  const conversion = pct(paidOrders.length + cancelledOrders.length, conversionBase);
  const pixShare = pct(pay.Pix.tickets, pay.Pix.tickets + pay['Cartão'].tickets);
  const cardFeePerTicket = pay['Cartão'].tickets ? pay['Cartão'].fee / pay['Cartão'].tickets : 0;
  const pixFeePerTicket = pay.Pix.tickets ? pay.Pix.fee / pay.Pix.tickets : 0;
  const pendingValue = pendingOrders.reduce((s, o) => s + o.totalAmount, 0);

  // ---- KPIs -----------------------------------------------------------------
  const kpis = [
    { label: 'Ingressos vendidos', value: fmtInt(ticketsSold), sub: `${fmtInt(paidOrders.length)} pedidos · ${fmtInt(buyers)} compradores` },
    { label: 'Receita bruta', value: fmtBrl(gross), sub: `Ticket médio ${fmtBrl(avgTicket)}` },
    { label: unsyncedCount ? 'Receita líquida (estimada)' : 'Receita líquida', value: fmtBrl(net), sub: `Taxas Mercado Pago: ${fmtBrl(fees)}` },
    { label: 'Compareceram', value: fmtInt(attended), sub: `de ${fmtInt(validTickets)} ingressos válidos · ${fmtPct(pct(attended, validTickets))}` },
    { label: 'Não compareceram', value: fmtInt(noShow), sub: fmtPct(pct(noShow, validTickets)) + ' dos ingressos válidos' },
    { label: 'Cortesias', value: fmtInt(courtesyTickets.length), sub: `${fmtInt(usedCourtesy.length)} compareceram (${fmtPct(courtesyAttendance)})` },
    { label: 'Cancelamentos', value: fmtInt(cancelledOrders.length), sub: `${fmtBrl(refunded)} reembolsados` },
    { label: 'Conversão de pedidos', value: fmtPct(conversion), sub: `${fmtInt(pendingOrders.length)} pendentes · ${fmtInt(rejectedOrders.length)} recusados` },
  ];

  // ---- insights -----------------------------------------------------------------
  const findings = [];
  const todo = [];
  const soldOutLotes = loteRows.filter((l) => !l.isTest && l.soldOut);

  if (ticketsSold) {
    findings.push({
      title: 'Vendas e público',
      text: `Foram vendidos ${fmtInt(ticketsSold)} ingressos (${fmtBrl(gross)} brutos) para ${fmtInt(buyers)} compradores` +
        (attended ? `, e ${fmtInt(attended)} pessoas compareceram (${fmtPct(pct(attended, validTickets))} dos ingressos válidos).` : '. A conferência na portaria ainda não tem registros.'),
    });
  }
  if (validTickets && attended) {
    findings.push({
      title: 'Taxa de comparecimento',
      text: `Pagantes: ${fmtPct(paidAttendance)} compareceram. ` +
        (courtesyTickets.length ? `Cortesias: ${fmtPct(courtesyAttendance)}. ` : '') +
        `Ficaram de fora ${fmtInt(noShow)} ingressos válidos que não foram usados.`,
    });
    todo.push({
      title: 'Planeje a capacidade com o no-show',
      text: `Com ${fmtPct(100 - paidAttendance)} de ausência entre pagantes, para cada 100 pessoas que você quer dentro da festa a venda precisa ser de cerca de ${fmtInt(100 / Math.max(paidAttendance / 100, 0.01))} ingressos. ` +
        'Use esse número com cautela (é um evento só) e respeite a capacidade legal do local.',
    });
  }
  if (courtesyTickets.length && validTickets) {
    findings.push({
      title: 'Cortesias',
      text: `${fmtPct(pct(courtesyTickets.length, validTickets))} dos ingressos válidos foram cortesia, e ${fmtPct(courtesyAttendance)} delas foram usadas` +
        (paidAttendance ? (courtesyAttendance >= paidAttendance ? ', um aproveitamento igual ou maior que o dos pagantes.' : `, abaixo dos ${fmtPct(paidAttendance)} dos pagantes.`) : '.'),
    });
    if (courtesyTickets.length >= 10 && courtesyAttendance < paidAttendance - 10) {
      todo.push({
        title: 'Reduza o desperdício de cortesias',
        text: 'As cortesias foram menos usadas que os ingressos pagos. Para os próximos eventos, limite a quantidade por convidado e confirme presença 2 dias antes.',
      });
    }
  }
  if (soldOutLotes.length) {
    const fastest = soldOutLotes.slice().sort((a, b) => a.daysToSell - b.daysToSell)[0];
    findings.push({
      title: 'Lotes esgotados',
      text: `${fmtInt(soldOutLotes.length)} ${plural(soldOutLotes.length, 'lote esgotou', 'lotes esgotaram')}. O mais rápido foi o ${fastest.name} (${fmtInt(fastest.capacity)} ingressos a ${fmtBrl(fastest.price)}) em ${fmtInt(fastest.daysToSell)} ${plural(fastest.daysToSell, 'dia', 'dias')}.`,
    });
    if (fastest.daysToSell <= 1 && fastest.capacity <= 200) {
      todo.push({
        title: 'Lotes iniciais pequenos esgotam na hora',
        text: `O ${fastest.name} acabou em ${fmtInt(fastest.daysToSell)} dia. Há espaço para um primeiro lote maior ou com preço um pouco mais alto, ou para usar a escassez de propósito (lote relâmpago com divulgação forte).`,
      });
    }
  }
  const lowAttendLote = loteRows.filter((l) => !l.isTest && l.valid >= 20).sort((a, b) => a.attendance - b.attendance)[0];
  if (lowAttendLote && attended) {
    findings.push({
      title: 'Comparecimento por lote',
      text: `O lote com menor comparecimento foi o ${lowAttendLote.name} (${fmtPct(lowAttendLote.attendance)}), a ${fmtBrl(lowAttendLote.price)}.`,
    });
  }
  if (leadCounts.reduce((s, n) => s + n, 0)) {
    findings.push({
      title: 'Quando o público comprou',
      text: `${fmtPct(lastWeekShare)} das vendas foram na última semana e ${fmtPct(lastDaysShare)} nos últimos 2 dias. O horário de pico de compra foi ${String(peakBuyHour).padStart(2, '0')}h e o dia da semana mais forte foi ${WEEKDAYS[peakDow]}.`,
    });
    todo.push({
      title: 'Concentre a divulgação nos horários que convertem',
      text: `Programe posts e anúncios para um pouco antes das ${String(peakBuyHour).padStart(2, '0')}h e reforce ${WEEKDAYS_PLURAL[peakDow]}. ` +
        (lastWeekShare >= 40 ? 'Como grande parte das vendas veio na última semana, reserve verba e conteúdo para a reta final.' : 'As vendas vieram antecipadas, então vale abrir a venda mais cedo com lotes menores.'),
    });
  }
  if (pay.Pix.tickets + pay['Cartão'].tickets) {
    findings.push({
      title: 'Forma de pagamento',
      text: `${fmtPct(pixShare)} dos ingressos foram pagos com Pix e ${fmtPct(100 - pixShare)} no cartão` +
        (pay['Cartão'].fee > 0 && pay.Pix.fee >= 0 && pay.Pix.tickets ? `. A taxa média por ingresso foi ${fmtBrl(pixFeePerTicket)} no Pix e ${fmtBrl(cardFeePerTicket)} no cartão.` : '.'),
    });
    if (cardFeePerTicket > pixFeePerTicket && pixShare < 80) {
      todo.push({
        title: 'Incentive o Pix',
        text: `O cartão custa ${fmtBrl(cardFeePerTicket - pixFeePerTicket)} a mais por ingresso em taxas. Destacar o Pix no checkout reduz custo sem mudar o preço.`,
      });
    }
  }
  if (geoTotal && topDdd.length) {
    const [d0, n0] = topDdd[0];
    findings.push({
      title: 'Origem do público',
      text: `${fmtPct(pct(n0, geoTotal))} dos compradores têm DDD ${d0} (${DDD_UF[d0] || '??'}). ` +
        `Os próximos: ${topDdd.slice(1, 4).map(([d, n]) => `DDD ${d} (${fmtPct(pct(n, geoTotal))})`).join(', ') || 'sem outras regiões relevantes'}.`,
    });
    todo.push({
      title: 'Segmente anúncios por região',
      text: `Concentre a verba nas regiões dos DDDs ${topDdd.slice(0, 3).map(([d]) => d).join(', ')} e teste expandir para as seguintes com um lote específico.`,
    });
  }
  if (paidOrders.length) {
    const avgQty = paidTickets.length / paidOrders.length;
    findings.push({
      title: 'Tamanho dos pedidos',
      text: `Em média ${avgQty.toFixed(2).replace('.', ',')} ingressos por pedido; ${fmtPct(pct(multi.length, paidOrders.length))} dos pedidos tiveram 2 ou mais ingressos.` +
        (repeatBuyers ? ` ${fmtInt(repeatBuyers)} ${plural(repeatBuyers, 'comprador fez', 'compradores fizeram')} mais de um pedido.` : ''),
    });
    if (multi.length >= 5) {
      todo.push({
        title: 'Combos para grupos',
        text: 'Como boa parte compra em grupo, vale testar combos (ex.: 4 ingressos com desconto ou ingresso "traga um amigo") para aumentar o ticket por pedido.',
      });
    }
  }
  if (multiTickets.length) {
    findings.push({
      title: 'Cadastro de participantes',
      text: `Em pedidos com mais de um ingresso, só ${fmtPct(pct(named, multiTickets.length))} dos ingressos têm o participante cadastrado.`,
    });
    if (pct(named, multiTickets.length) < 50) {
      todo.push({
        title: 'Peça o nome de cada participante antes do evento',
        text: 'Sem o cadastro você não sabe quem foi: envie um lembrete 3 dias antes pedindo o nome de quem vai usar cada ingresso. Isso melhora a base de contatos para a próxima edição.',
      });
    }
  }
  if (pendingOrders.length) {
    findings.push({
      title: 'Pedidos não concluídos',
      text: `${fmtInt(pendingOrders.length)} pedidos ficaram pendentes (${fmtBrl(pendingValue)} em valor): em geral Pix gerado e não pago. A conversão de pedidos foi ${fmtPct(conversion)}.`,
    });
    todo.push({
      title: 'Recupere os Pix não pagos',
      text: 'Envie um lembrete automático 15 e 60 minutos após gerar o Pix, e faça o QR Code expirar com aviso claro. É a venda mais barata de recuperar.',
    });
  }
  if (cancelledOrders.length) {
    findings.push({
      title: 'Cancelamentos',
      text: `${fmtInt(cancelledOrders.length)} pedidos cancelados (${fmtPct(pct(cancelledOrders.length, cancelledOrders.length + paidOrders.length))} das vendas), com ${fmtBrl(refunded)} reembolsados.`,
    });
  }
  if (peakArrival && attended) {
    findings.push({
      title: 'Chegada na portaria',
      text: `O pico de chegada foi às ${peakArrival.label} (${fmtInt(peakArrival.value)} entradas, ${fmtPct(pct(peakArrival.value, attended))} do público).`,
    });
    todo.push({
      title: 'Dimensione a portaria para o pico',
      text: `Reforce validadores e abra mais filas por volta das ${peakArrival.label}. Com ${fmtInt(peakArrival.value)} entradas na hora de pico, são cerca de ${fmtInt(peakArrival.value / 60)} pessoas por minuto.`,
    });
  }
  if (unsyncedCount) {
    findings.push({
      title: 'Receita líquida estimada',
      text: `${fmtInt(unsyncedCount)} pedidos ainda não foram sincronizados com o Mercado Pago, então a receita líquida usa o valor cheio deles. Sincronize em Contabilidade para fechar o número.`,
    });
  }

  // ---- charts (rendered client-side) ----------------------------------------------
  const charts = {
    diario: {
      id: 'diario', title: 'Ingressos vendidos por dia', subtitle: 'Empilhado por lote · dia da compra',
      type: 'columns', stacked: true, unit: 'ingressos',
      categories: days.map(dayLabel), series: dailySeries, marker: startBrt ? dayLabel(startBrt.key) : null,
    },
    acumulado: {
      id: 'acumulado', title: 'Vendas acumuladas', subtitle: 'Total de ingressos ao longo do tempo',
      type: 'line', unit: 'ingressos', categories: days.map(dayLabel), series: [{ name: 'Acumulado', values: cumulative }],
    },
    lotes: {
      id: 'lotes', title: 'Ingressos por lote', subtitle: 'Vendidos x capacidade do lote',
      type: 'bars', unit: 'ingressos', categories: loteRows.filter((l) => !l.isTest).map((l) => l.name),
      series: [{ name: 'Vendidos', values: loteRows.filter((l) => !l.isTest).map((l) => l.sold) }],
      extra: loteRows.filter((l) => !l.isTest).map((l) => `de ${fmtInt(l.capacity)}`),
    },
    horaCompra: {
      id: 'horaCompra', title: 'Horário das compras', subtitle: 'Ingressos por hora do dia (Brasília)',
      type: 'columns', emphasis: true, unit: 'ingressos',
      categories: hourBuy.map((_, h) => `${String(h).padStart(2, '0')}h`), series: [{ name: 'Ingressos', values: hourBuy }],
    },
    diaSemana: {
      id: 'diaSemana', title: 'Dia da semana das compras', subtitle: 'Ingressos por dia da semana',
      type: 'columns', emphasis: true, unit: 'ingressos', categories: WEEKDAYS, series: [{ name: 'Ingressos', values: dowBuy }],
    },
    antecedencia: {
      id: 'antecedencia', title: 'Antecedência da compra', subtitle: 'Dias entre a compra e o evento',
      type: 'columns', emphasis: true, unit: 'ingressos', categories: leadBins.map((b) => b.label), series: [{ name: 'Ingressos', values: leadCounts }],
    },
    tamanhoPedido: {
      id: 'tamanhoPedido', title: 'Ingressos por pedido', subtitle: 'Quantos pedidos tiveram 1, 2, 3... ingressos',
      type: 'columns', emphasis: true, unit: 'pedidos',
      categories: sizeKeys.map((k) => `${k} ingresso${k === 1 ? '' : 's'}`), series: [{ name: 'Pedidos', values: sizeKeys.map((k) => sizeMap[k]) }],
    },
    ddd: {
      id: 'ddd', title: 'Origem do público (DDD)', subtitle: 'Top 8 regiões pelo telefone da compra',
      type: 'bars', unit: 'ingressos', categories: topDdd.map(([d]) => `DDD ${d} · ${DDD_UF[d] || '??'}`),
      series: [{ name: 'Ingressos', values: topDdd.map(([, n]) => n) }],
      extra: topDdd.map(([, n]) => fmtPct(pct(n, geoTotal))),
    },
    chegada: {
      id: 'chegada', title: 'Chegada na portaria', subtitle: 'Entradas validadas por hora',
      type: 'columns', emphasis: true, unit: 'entradas', categories: arrival.map((a) => a.label), series: [{ name: 'Entradas', values: arrival.map((a) => a.value) }],
    },
    comparecimentoLote: {
      id: 'comparecimentoLote', title: 'Comparecimento por lote', subtitle: '% dos ingressos válidos que foram usados',
      type: 'bars', unit: '%', categories: loteRows.filter((l) => !l.isTest && l.valid > 0).map((l) => l.name),
      series: [{ name: 'Comparecimento', values: loteRows.filter((l) => !l.isTest && l.valid > 0).map((l) => Math.round(l.attendance * 10) / 10) }],
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    event: { name: eventInfo.name, dateLabel: eventInfo.dateLabel, venue: eventInfo.venue, startIso },
    kpis,
    charts,
    payment: [
      { name: 'Pix', tickets: pay.Pix.tickets, orders: pay.Pix.orders, gross: round2(pay.Pix.gross) },
      { name: 'Cartão', tickets: pay['Cartão'].tickets, orders: pay['Cartão'].orders, gross: round2(pay['Cartão'].gross) },
    ],
    attendance: [
      { name: 'Pagantes', valid: paidTickets.length, used: usedPaid.length },
      { name: 'Cortesias', valid: courtesyTickets.length, used: usedCourtesy.length },
    ],
    lotes: loteRows.map((l) => ({
      ...l,
      priceLabel: fmtBrl(l.price),
      revenueLabel: fmtBrl(l.revenue),
      attendanceLabel: l.valid ? fmtPct(l.attendance) : '-',
      periodLabel: l.firstDay ? `${dayLabel(l.firstDay)} a ${dayLabel(l.lastDay)}` : '-',
    })),
    findings,
    recommendations: todo,
    totals: {
      ticketsSold, gross: round2(gross), net: round2(net), fees: round2(fees), refunded: round2(refunded),
      validTickets, attended, noShow, courtesy: courtesyTickets.length, unsyncedCount,
      orders: { paid: paidOrders.length, cancelled: cancelledOrders.length, pending: pendingOrders.length, rejected: rejectedOrders.length },
    },
    hasData: ticketsSold + courtesyTickets.length > 0,
  };
}

function registerRelatorioRoutes(app, { requireAdminAuth, eventInfo }) {
  app.get('/admin/relatorio', requireAdminAuth, (req, res) => {
    const db = store.load();
    res.render('admin_relatorio', { eventInfo, report: buildReport(db, eventInfo) });
  });
}

module.exports = { registerRelatorioRoutes, buildReport };
