const crypto = require('crypto');
const data = require('./afiliadosStore');
const { isValidCpf } = require('./cpf');

// ---------------------------------------------------------------------------
// Affiliate programme for the "Crie sua Propria Musica" tool.
//  - 15% of each sale (AFILIADO_PCT), cookie valid for 90 days (AFILIADO_DIAS)
//  - several affiliates can get a click from the same person: the commission is split
//    between them in proportion to their counted clicks (AFILIADO_ATRIBUICAO=igual splits equally)
//  - commissions are released after a grace period (AFILIADO_CARENCIA_DIAS) and paid out
//    manually (Pix) from /admin/afiliados once an affiliate reaches AFILIADO_MIN_SAQUE
// ---------------------------------------------------------------------------
const PCT = Number(process.env.AFILIADO_PCT || 15);
const DIAS = Number(process.env.AFILIADO_DIAS || 90);
const CARENCIA_DIAS = Number(process.env.AFILIADO_CARENCIA_DIAS || 7);
const MIN_SAQUE = Number(process.env.AFILIADO_MIN_SAQUE || 20);
const MODO = process.env.AFILIADO_ATRIBUICAO === 'igual' ? 'igual' : 'proporcional';
const DAY = 86400000;

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => 'R$ ' + round2(n).toFixed(2).replace('.', ',');
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const rid = () => crypto.randomBytes(8).toString('hex');

// ---- passwords / sessions --------------------------------------------------------------
function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(senha), salt, 64).toString('hex');
}
function confereSenha(senha, hash) {
  const [salt, h] = String(hash || '').split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(String(senha), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const rate = new Map();
function limited(key, max, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const list = (rate.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  rate.set(key, list);
  return list.length > max;
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

function cookieOpts(req, maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https'), maxAge: maxAgeMs };
}

// ---- affiliates --------------------------------------------------------------------------
const slugBase = (nome) => String(nome || 'afiliado').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 10) || 'afiliado';
function novoCodigo(d, nome) {
  for (let i = 0; i < 20; i += 1) {
    const c = `${slugBase(nome)}-${crypto.randomBytes(2).toString('hex')}`;
    if (!Object.values(d.afiliados).some((a) => a.codigo === c)) return c;
  }
  return `afiliado-${rid()}`;
}
const porCodigo = (d, codigo) => Object.values(d.afiliados).find((a) => a.codigo === codigo) || null;
const publico = (a) => ({ id: a.id, codigo: a.codigo, nome: a.nome, email: a.email, whatsapp: a.whatsapp, pix: a.pix, banco: a.banco || null, status: a.status });

const PIX_TIPOS = ['cpf', 'email', 'telefone', 'aleatoria', 'cnpj'];
function validaPix(tipo, chave) {
  const t = String(tipo || '');
  const c = String(chave || '').trim();
  if (!PIX_TIPOS.includes(t) || !c) return null;
  if (t === 'cpf') return isValidCpf(onlyDigits(c)) ? { tipo: t, chave: onlyDigits(c) } : null;
  if (t === 'cnpj') return onlyDigits(c).length === 14 ? { tipo: t, chave: onlyDigits(c) } : null;
  if (t === 'telefone') return onlyDigits(c).length >= 10 ? { tipo: t, chave: onlyDigits(c) } : null;
  if (t === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) ? { tipo: t, chave: c.toLowerCase() } : null;
  return c.length >= 20 ? { tipo: t, chave: c } : null;
}
function leBanco(body) {
  const banco = String(body.banco || '').trim().slice(0, 60);
  const agencia = String(body.agencia || '').trim().slice(0, 12);
  const conta = String(body.conta || '').trim().slice(0, 20);
  if (!banco && !agencia && !conta) return null;
  return { banco, agencia, conta, tipoConta: body.tipoConta === 'poupanca' ? 'poupanca' : 'corrente' };
}

// ---- clicks and attribution ------------------------------------------------------------
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|headless|curl|wget|python|axios|node-fetch/i;
const COOKIE_VID = 'crew_vid';

function registraClique(req, res, codigo) {
  const d = data.load();
  const a = porCodigo(d, codigo);
  if (!a || a.status !== 'ativo') return false;
  const sess = sessaoDe(req);
  if (sess && sess.afiliadoId === a.id) return false; // affiliates' own visits do not count
  if (BOT.test(req.headers['user-agent'] || '')) return false;

  let vid = String(req.cookies[COOKIE_VID] || '');
  if (!/^[a-f0-9]{16,32}$/.test(vid)) vid = crypto.randomBytes(12).toString('hex');
  res.cookie(COOKIE_VID, vid, cookieOpts(req, DIAS * DAY));

  const agora = Date.now();
  // at most one counted click per visitor, per affiliate, per 24h
  for (let i = d.cliques.length - 1; i >= 0 && d.cliques[i][2] > agora - DAY; i -= 1) {
    if (d.cliques[i][0] === vid && d.cliques[i][1] === a.codigo) return true;
  }
  data.withData((x) => {
    x.cliques.push([vid, a.codigo, agora]);
    // keep the file small: clicks older than the cookie window (+ margin) are useless
    if (x.cliques.length > 20000) {
      const corte = agora - (DIAS + 30) * DAY;
      x.cliques = x.cliques.filter((c) => c[2] >= corte);
    }
  }).catch((err) => console.error('Falha ao gravar clique de afiliado:', err.message));
  return true;
}

// Snapshot of who gets credit for a purchase made by this browser (the click cookie).
function atribuirCompra({ vid, email, cpf }) {
  if (!/^[a-f0-9]{16,32}$/.test(String(vid || ''))) return null;
  const d = data.load();
  const desde = Date.now() - DIAS * DAY;
  const cont = {};
  d.cliques.forEach(([v, codigo, ts]) => { if (v === vid && ts >= desde) cont[codigo] = (cont[codigo] || 0) + 1; });
  const emailN = String(email || '').trim().toLowerCase();
  const cpfN = onlyDigits(cpf);
  const lista = Object.entries(cont).filter(([codigo]) => {
    const a = porCodigo(d, codigo);
    if (!a || a.status !== 'ativo') return false;
    const proprio = (emailN && a.email === emailN) || (cpfN && a.cpf === cpfN);
    return !proprio; // buying through your own link earns nothing
  });
  if (!lista.length) return null;
  const total = lista.reduce((s, [, n]) => s + n, 0);
  return {
    vid,
    modo: MODO,
    pct: PCT,
    shares: lista.map(([codigo, n]) => ({ codigo, cliques: n, parte: MODO === 'igual' ? 1 / lista.length : n / total })),
  };
}

// WhatsApp sales: the cookie cannot follow the lead into WhatsApp, so the tracking link puts a
// short code (first 12 hex chars of the visitor id) in the pre-filled message. The bot hands it
// back when it creates the order and the same click history is used.
function atribuirPorRef(ref, { email, cpf } = {}) {
  const r = String(ref || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (r.length < 12) return null;
  const d = data.load();
  const desde = Date.now() - DIAS * DAY;
  const hit = d.cliques.find(([v, , ts]) => ts >= desde && v.startsWith(r));
  return hit ? atribuirCompra({ vid: hit[0], email, cpf }) : null;
}

const numeroBot = () => {
  const ddi = process.env.DEFAULT_COUNTRY_CODE || '55';
  const raw = onlyDigits(process.env.BUSINESS_WHATSAPP_NUMBER || '2139557816');
  return raw.startsWith(ddi) && raw.length > 11 ? raw : ddi + raw;
};
// wa.me link that opens the music bot with the "criar musica" message + the referral code
function linkWhatsapp(vid) {
  const code = /^[a-f0-9]{16,32}$/.test(String(vid || '')) ? ' Ref: ' + vid.slice(0, 12) : '';
  const texto = 'Olá! Quero criar minha música personalizada.' + code;
  return 'https://wa.me/' + numeroBot() + '?text=' + encodeURIComponent(texto);
}

// Called when a music order is paid: turns the attribution snapshot into commissions.
async function registrarVenda(pedido) {
  const af = pedido && pedido.afiliacao;
  if (!af || !Array.isArray(af.shares) || !af.shares.length) return [];
  const valor = Number(pedido.valor) || 0;
  const totalCent = Math.round(valor * (af.pct || PCT));  // valor*pct/100 in cents
  // split in cents: floor each share, hand the leftover cents to the biggest shares
  const parts = af.shares.map((s) => ({ ...s, cent: Math.floor(totalCent * s.parte) }));
  let sobra = totalCent - parts.reduce((s, p) => s + p.cent, 0);
  [...parts].sort((a, b) => b.parte - a.parte).forEach((p) => { if (sobra > 0) { p.cent += 1; sobra -= 1; } });
  const criadas = [];
  await data.withData((d) => {
    parts.forEach((p) => {
      const a = porCodigo(d, p.codigo);
      const id = `${pedido.id}:${p.codigo}`;
      if (!a || p.cent <= 0 || d.comissoes[id]) return;
      d.comissoes[id] = {
        id, pedidoId: pedido.id, canal: pedido.canal || 'site', codigo: p.codigo, afiliadoId: a.id, valor: p.cent / 100, valorVenda: valor, cliques: p.cliques,
        parte: round2(p.parte), status: 'ativa', criadaEm: new Date().toISOString(), liberaEm: new Date(Date.now() + CARENCIA_DIAS * DAY).toISOString(),
      };
      criadas.push(id);
    });
  });
  return criadas;
}

// ---- balances --------------------------------------------------------------------------
function situacao(c, agora = Date.now()) {
  if (c.status === 'paga') return 'paga';
  if (c.status === 'cancelada') return 'cancelada';
  return Date.parse(c.liberaEm) <= agora ? 'liberada' : 'pendente';
}
function resumo(d, afiliado) {
  const agora = Date.now();
  const desde = agora - DIAS * DAY;
  const meus = Object.values(d.comissoes).filter((c) => c.afiliadoId === afiliado.id);
  const soma = (st) => round2(meus.filter((c) => situacao(c, agora) === st).reduce((s, c) => s + c.valor, 0));
  const cliques = d.cliques.filter((c) => c[1] === afiliado.codigo && c[2] >= desde);
  return {
    cliques: cliques.length,
    visitantes: new Set(cliques.map((c) => c[0])).size,
    vendas: meus.filter((c) => c.status !== 'cancelada').length,
    pendente: soma('pendente'),
    liberada: soma('liberada'),
    paga: soma('paga'),
    total: round2(meus.filter((c) => c.status !== 'cancelada').reduce((s, c) => s + c.valor, 0)),
  };
}

// ---- session of a logged-in affiliate -----------------------------------------------------
function sessaoDe(req) {
  const tok = req.cookies && req.cookies.crew_aff;
  if (!tok) return null;
  const d = data.load();
  const s = d.sessoes[sha(tok)];
  if (!s || s.expiraEm < Date.now()) return null;
  return s;
}
function afiliadoLogado(req) {
  const s = sessaoDe(req);
  return s ? data.load().afiliados[s.afiliadoId] || null : null;
}
async function abreSessao(req, res, afiliadoId) {
  const tok = crypto.randomBytes(32).toString('hex');
  await data.withData((d) => {
    const agora = Date.now();
    Object.entries(d.sessoes).forEach(([k, s]) => { if (s.expiraEm < agora) delete d.sessoes[k]; });
    d.sessoes[sha(tok)] = { afiliadoId, expiraEm: agora + 30 * DAY };
  });
  res.cookie('crew_aff', tok, cookieOpts(req, 30 * DAY));
}

// ---- routes --------------------------------------------------------------------------------
function registerAfiliadosRoutes(app, { requireAdminAuth, eventInfo, formatDatetimeBrasiliaDisplay }) {
  const info = { pct: PCT, dias: DIAS, carencia: CARENCIA_DIAS, minSaque: MIN_SAQUE, modo: MODO };
  const base = () => (process.env.BASE_URL || '').replace(/\/$/, '');
  const linkDe = (a) => `${base()}/a/${a.codigo}`;

  // tracking link: /a/CODE -> sets the cookie and sends the visitor to the tool
  app.get('/a/:codigo', (req, res) => {
    registraClique(req, res, String(req.params.codigo || '').toLowerCase());
    res.redirect(302, '/criesuamusica');
  });

  // WhatsApp tracking link: counts the click, then opens the bot with the referral code.
  app.get('/a/:codigo/zap', (req, res) => {
    registraClique(req, res, String(req.params.codigo || '').toLowerCase());
    // the cookie was just set in this response, so read the id from either source
    const setado = (res.getHeader('Set-Cookie') || []).toString().match(new RegExp(COOKIE_VID + '=([a-f0-9]{16,32})'));
    const vid = (req.cookies && req.cookies[COOKIE_VID]) || (setado && setado[1]) || '';
    res.redirect(302, linkWhatsapp(vid));
  });
  // "Prefer WhatsApp?" button of the tool page: uses the visitor's cookie, if any
  app.get('/criesuamusica/whatsapp', (req, res) => {
    res.redirect(302, linkWhatsapp(req.cookies && req.cookies[COOKIE_VID]));
  });

  // ?ref=CODE on any page also counts (e.g. a link to the home page or to /links)
  app.use((req, res, next) => {
    if (req.method === 'GET' && typeof req.query.ref === 'string' && /^[a-z0-9-]{3,24}$/i.test(req.query.ref)) {
      registraClique(req, res, req.query.ref.toLowerCase());
    }
    next();
  });

  app.get('/afiliados', (req, res) => {
    if (afiliadoLogado(req)) return res.redirect('/afiliados/painel');
    return res.render('afiliados', { eventInfo, info, aba: req.query.entrar ? 'entrar' : 'cadastro' });
  });
  app.get('/afiliados/termos', (req, res) => res.render('afiliados_termos', { eventInfo, info }));

  app.post('/api/afiliados/cadastro', async (req, res) => {
    const ip = ipOf(req);
    if (req.body.website) return res.json({ ok: true, redirect: '/afiliados/painel' }); // honeypot
    if (limited(`cad:${ip}`, 20)) return res.status(429).json({ error: 'Muitas tentativas. Tente de novo mais tarde.' });
    const nome = String(req.body.nome || '').trim().slice(0, 80);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
    const cpf = onlyDigits(req.body.cpf);
    const whatsapp = onlyDigits(req.body.whatsapp);
    const senha = String(req.body.senha || '');
    const pix = validaPix(req.body.pixTipo, req.body.pixChave);
    if (nome.length < 3) return res.status(400).json({ error: 'Informe seu nome completo.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
    if (!isValidCpf(cpf)) return res.status(400).json({ error: 'CPF inválido.' });
    if (whatsapp.length < 10 || whatsapp.length > 13) return res.status(400).json({ error: 'WhatsApp inválido (com DDD).' });
    if (senha.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (!pix) return res.status(400).json({ error: 'Chave Pix inválida. Confira o tipo e a chave.' });
    if (!req.body.aceito) return res.status(400).json({ error: 'É preciso aceitar os termos do programa.' });

    const resultado = await data.withData((d) => {
      const lista = Object.values(d.afiliados);
      if (lista.some((a) => a.email === email)) return { erro: 'Já existe um cadastro com esse e-mail. Entre na sua conta.' };
      if (lista.some((a) => a.cpf === cpf)) return { erro: 'Já existe um cadastro com esse CPF. Entre na sua conta.' };
      const id = rid();
      d.afiliados[id] = {
        id, codigo: novoCodigo(d, nome), nome, email, cpf, whatsapp, senhaHash: hashSenha(senha), pix, banco: leBanco(req.body),
        status: 'ativo', criadoEm: new Date().toISOString(), aceitouTermosEm: new Date().toISOString(),
      };
      return { id };
    });
    if (resultado.erro) return res.status(409).json({ error: resultado.erro });
    await abreSessao(req, res, resultado.id);
    return res.json({ ok: true, redirect: '/afiliados/painel' });
  });

  app.post('/api/afiliados/login', async (req, res) => {
    const ip = ipOf(req);
    const email = String(req.body.email || '').trim().toLowerCase();
    if (limited(`login:${ip}`, 15) || limited(`login:${email}`, 8)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco.' });
    const a = Object.values(data.load().afiliados).find((x) => x.email === email);
    if (!a || !confereSenha(req.body.senha, a.senhaHash)) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    if (a.status !== 'ativo') return res.status(403).json({ error: 'Esta conta está bloqueada. Fale com a equipe da Crewolada.' });
    await abreSessao(req, res, a.id);
    return res.json({ ok: true, redirect: '/afiliados/painel' });
  });

  app.post('/afiliados/sair', async (req, res) => {
    const tok = req.cookies.crew_aff;
    if (tok) await data.withData((d) => { delete d.sessoes[sha(tok)]; });
    res.clearCookie('crew_aff');
    res.redirect('/afiliados');
  });

  app.get('/afiliados/painel', (req, res) => {
    const a = afiliadoLogado(req);
    if (!a) return res.redirect('/afiliados?entrar=1');
    const d = data.load();
    const comissoes = Object.values(d.comissoes).filter((c) => c.afiliadoId === a.id)
      .sort((x, y) => (y.criadaEm || '').localeCompare(x.criadaEm || ''))
      .slice(0, 100).map((c) => ({ ...c, situacao: situacao(c), em: formatDatetimeBrasiliaDisplay(c.criadaEm), libera: formatDatetimeBrasiliaDisplay(c.liberaEm) }));
    res.render('afiliados_painel', {
      eventInfo, info, afiliado: publico(a), link: linkDe(a), linkZap: linkDe(a) + '/zap', resumo: resumo(d, a), comissoes, money,
      salvo: req.query.salvo === '1', pagamentos: Object.values(d.pagamentos).filter((p) => p.afiliadoId === a.id).sort((x, y) => y.em.localeCompare(x.em)).map((p) => ({ ...p, quando: formatDatetimeBrasiliaDisplay(p.em) })),
    });
  });

  app.post('/api/afiliados/repasse', async (req, res) => {
    const a = afiliadoLogado(req);
    if (!a) return res.status(401).json({ error: 'Faça login novamente.' });
    const pix = validaPix(req.body.pixTipo, req.body.pixChave);
    if (!pix) return res.status(400).json({ error: 'Chave Pix inválida. Confira o tipo e a chave.' });
    await data.withData((d) => { d.afiliados[a.id].pix = pix; d.afiliados[a.id].banco = leBanco(req.body); });
    return res.json({ ok: true });
  });

  // ---- admin ------------------------------------------------------------------------------
  app.get('/admin/afiliados', requireAdminAuth, (req, res) => {
    const d = data.load();
    const linhas = Object.values(d.afiliados).map((a) => ({ ...publico(a), cpf: a.cpf, criadoEm: formatDatetimeBrasiliaDisplay(a.criadoEm), r: resumo(d, a), link: linkDe(a) }))
      .sort((x, y) => y.r.liberada - x.r.liberada || y.r.total - x.r.total);
    const comissoes = Object.values(d.comissoes).sort((x, y) => (y.criadaEm || '').localeCompare(x.criadaEm || '')).slice(0, 80)
      .map((c) => ({ ...c, situacao: situacao(c), em: formatDatetimeBrasiliaDisplay(c.criadaEm), nome: (d.afiliados[c.afiliadoId] || {}).nome || c.codigo }));
    const pagamentos = Object.values(d.pagamentos).sort((x, y) => y.em.localeCompare(x.em)).slice(0, 40)
      .map((p) => ({ ...p, quando: formatDatetimeBrasiliaDisplay(p.em), nome: (d.afiliados[p.afiliadoId] || {}).nome || '' }));
    const totais = linhas.reduce((t, l) => ({ aPagar: t.aPagar + l.r.liberada, pendente: t.pendente + l.r.pendente, pago: t.pago + l.r.paga }), { aPagar: 0, pendente: 0, pago: 0 });
    res.render('admin_afiliados', { eventInfo, info, linhas, comissoes, pagamentos, totais, money, msg: req.query.msg || '', novaSenha: req.query.senha || '' });
  });

  app.post('/admin/afiliados/:id/pagar', requireAdminAuth, async (req, res) => {
    const obs = String(req.body.obs || '').trim().slice(0, 120);
    const r = await data.withData((d) => {
      const a = d.afiliados[req.params.id];
      if (!a) return null;
      const agora = Date.now();
      const itens = Object.values(d.comissoes).filter((c) => c.afiliadoId === a.id && situacao(c, agora) === 'liberada');
      const valor = round2(itens.reduce((s, c) => s + c.valor, 0));
      if (!itens.length || valor <= 0) return { vazio: true };
      const id = rid();
      d.pagamentos[id] = { id, afiliadoId: a.id, valor, em: new Date().toISOString(), obs, pix: a.pix, comissoes: itens.map((c) => c.id) };
      itens.forEach((c) => { c.status = 'paga'; c.pagamentoId = id; c.pagaEm = d.pagamentos[id].em; });
      return { valor };
    });
    res.redirect('/admin/afiliados?msg=' + (!r ? 'nao-encontrado' : r.vazio ? 'sem-saldo' : 'pago'));
  });

  app.post('/admin/afiliados/:id/status', requireAdminAuth, async (req, res) => {
    await data.withData((d) => {
      const a = d.afiliados[req.params.id];
      if (!a) return;
      a.status = req.body.status === 'bloqueado' ? 'bloqueado' : 'ativo';
      if (a.status === 'bloqueado') Object.entries(d.sessoes).forEach(([k, s]) => { if (s.afiliadoId === a.id) delete d.sessoes[k]; });
    });
    res.redirect('/admin/afiliados?msg=status');
  });

  app.post('/admin/afiliados/:id/senha', requireAdminAuth, async (req, res) => {
    const nova = crypto.randomBytes(5).toString('hex');
    const ok = await data.withData((d) => { const a = d.afiliados[req.params.id]; if (!a) return false; a.senhaHash = hashSenha(nova); return true; });
    res.redirect('/admin/afiliados?msg=senha' + (ok ? '&senha=' + nova : ''));
  });

  app.post('/admin/afiliados/comissoes/:id/cancelar', requireAdminAuth, async (req, res) => {
    await data.withData((d) => { const c = d.comissoes[req.params.id]; if (c && c.status === 'ativa') c.status = 'cancelada'; });
    res.redirect('/admin/afiliados?msg=cancelada');
  });

  app.get('/admin/afiliados/exportar.csv', requireAdminAuth, (req, res) => {
    const d = data.load();
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['nome', 'cpf', 'email', 'whatsapp', 'tipo_pix', 'chave_pix', 'banco', 'agencia', 'conta', 'a_pagar', 'pendente', 'pago']];
    Object.values(d.afiliados).forEach((a) => {
      const r = resumo(d, a);
      rows.push([a.nome, a.cpf, a.email, a.whatsapp, a.pix && a.pix.tipo, a.pix && a.pix.chave, a.banco && a.banco.banco, a.banco && a.banco.agencia, a.banco && a.banco.conta, r.liberada.toFixed(2), r.pendente.toFixed(2), r.paga.toFixed(2)]);
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="afiliados.csv"');
    res.send('﻿' + rows.map((r) => r.map(esc).join(',')).join('\n'));
  });
}

module.exports = { registerAfiliadosRoutes, atribuirCompra, atribuirPorRef, linkWhatsapp, registrarVenda, registraClique, PCT, DIAS, MIN_SAQUE, COOKIE_VID };
