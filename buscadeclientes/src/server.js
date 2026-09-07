require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');

const store = require('./store');
const places = require('./googlePlaces');
const { getSegments, getSegment, customSegment } = require('./segments');
const { CATEGORY_LABELS } = require('./siteAnalyzer');
const { renderLandingPage, buildDefaultSite } = require('./siteGenerator');
const { processSearch } = require('./searchProcessor');
const { sendWhatsapp, sendEmail, renderTemplate } = require('./messaging');

const app = express();
const PORT = process.env.PORT || 3100;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ---- autenticacao simples (sessao em memoria, cai ao reiniciar o servidor) ----
const sessions = new Set();

function requireAuth(req, res, next) {
  const token = req.cookies.bdc_session;
  if (token && sessions.has(token)) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { login, password } = req.body;
  if (login === process.env.ADMIN_LOGIN && password === process.env.ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    res.cookie('bdc_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 });
    return res.redirect('/');
  }
  res.render('login', { error: 'Login ou senha incorretos.' });
});

app.post('/logout', requireAuth, (req, res) => {
  sessions.delete(req.cookies.bdc_session);
  res.clearCookie('bdc_session');
  res.redirect('/login');
});

// ---- helpers ----
function envStatus() {
  return {
    googleMaps: !!(process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY !== 'SUA_CHAVE_AQUI'),
    messagingMode: (process.env.MESSAGING_MODE || 'n8n').toLowerCase(),
    whatsappReady:
      (process.env.MESSAGING_MODE || 'n8n').toLowerCase() === 'evolution_direct'
        ? !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE)
        : !!process.env.N8N_PROSPECCAO_WHATSAPP_WEBHOOK_URL,
    smtpReady: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
  };
}

function leadSummary(lead) {
  return {
    id: lead.id,
    name: lead.name,
    address: lead.address,
    phone: lead.phone,
    website: lead.website,
    rating: lead.rating,
    userRatingsTotal: lead.userRatingsTotal,
    category: lead.analysis.category,
    categoryLabel: CATEGORY_LABELS[lead.analysis.category],
    score: lead.analysis.score,
    status: lead.status,
    segmentLabel: lead.segmentLabel,
  };
}

// ---- dashboard / nova busca ----
app.get('/', requireAuth, (req, res) => {
  const db = store.load();
  const searches = Object.values(db.searches).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.render('home', { segments: getSegments(), searches, env: envStatus() });
});

app.post('/buscas', requireAuth, async (req, res) => {
  const { segmentKey, customKeyword, location, radiusKm } = req.body;
  const radius = Math.min(50, Math.max(1, Number(radiusKm) || 5));

  const segment = segmentKey && segmentKey !== 'personalizado' ? getSegment(segmentKey) : null;
  const resolvedSegment = segment || customSegment((customKeyword || '').trim() || 'negocio local');

  if (!location || !location.trim()) {
    return res.redirect('/');
  }

  let geo;
  try {
    geo = await places.geocode(location.trim());
  } catch (err) {
    const db = store.load();
    const searches = Object.values(db.searches).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.render('home', {
      segments: getSegments(),
      searches,
      env: envStatus(),
      error: err.message,
    });
  }

  const searchId = uuidv4();
  const search = {
    id: searchId,
    segmentKey: resolvedSegment.key,
    segmentLabel: resolvedSegment.label,
    templateFamily: resolvedSegment.templateFamily,
    keyword: resolvedSegment.keyword,
    radiusKm: radius,
    location: { query: location.trim(), lat: geo.lat, lng: geo.lng, formattedAddress: geo.formattedAddress },
    status: 'processando',
    totalFound: 0,
    processedCount: 0,
    leadIds: [],
    createdAt: new Date().toISOString(),
  };

  await store.withDb((db) => {
    db.searches[searchId] = search;
  });

  processSearch(searchId);

  res.redirect(`/buscas/${searchId}`);
});

app.get('/buscas/:id', requireAuth, (req, res) => {
  const db = store.load();
  const search = db.searches[req.params.id];
  if (!search) return res.status(404).send('Busca nao encontrada.');
  const leads = search.leadIds.map((id) => db.leads[id]).filter(Boolean);
  res.render('search', { search, leads, CATEGORY_LABELS });
});

app.get('/buscas/:id/status.json', requireAuth, (req, res) => {
  const db = store.load();
  const search = db.searches[req.params.id];
  if (!search) return res.status(404).json({ error: 'nao encontrada' });
  const leads = search.leadIds.map((id) => db.leads[id]).filter(Boolean).map(leadSummary);
  res.json({
    status: search.status,
    totalFound: search.totalFound,
    processedCount: search.processedCount,
    error: search.error || null,
    leads,
  });
});

// ---- leads ----
app.get('/leads', requireAuth, (req, res) => {
  const db = store.load();
  let leads = Object.values(db.leads);
  const { categoria, status, segmento } = req.query;
  if (categoria) leads = leads.filter((l) => l.analysis.category === categoria);
  if (status) leads = leads.filter((l) => l.status === status);
  if (segmento) leads = leads.filter((l) => l.segmentKey === segmento);
  leads = leads.sort((a, b) => (b.analysis.score - a.analysis.score) || b.createdAt.localeCompare(a.createdAt));
  res.render('leads', {
    leads,
    CATEGORY_LABELS,
    segments: getSegments(),
    filters: { categoria: categoria || '', status: status || '', segmento: segmento || '' },
  });
});

app.get('/leads/:id', requireAuth, (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead) return res.status(404).send('Lead nao encontrado.');

  const previewLink = `${(process.env.BASE_URL || '').replace(/\/$/, '')}/p/${lead.id}`;
  const vars = { nome: lead.name, negocio: lead.name, link: previewLink };
  const whatsappPreview = renderTemplate(db.settings.whatsappTemplate, vars);
  const emailSubjectPreview = renderTemplate(db.settings.emailSubject, vars);
  const emailBodyPreview = renderTemplate(db.settings.emailTemplate, vars);

  res.render('lead', {
    lead,
    CATEGORY_LABELS,
    previewLink,
    whatsappPreview,
    emailSubjectPreview,
    emailBodyPreview,
    enviado: req.query.enviado || null,
    erro: req.query.erro || null,
  });
});

app.post('/leads/:id/gerar-site', requireAuth, async (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead) return res.status(404).send('Lead nao encontrado.');
  const segment = getSegment(lead.segmentKey) || customSegment(lead.segmentLabel || 'negocio local');
  const site = buildDefaultSite(lead, segment);
  await store.withDb((d) => {
    d.leads[lead.id].site = site;
    d.leads[lead.id].status = 'site_gerado';
  });
  res.redirect(`/leads/${lead.id}`);
});

app.get('/leads/:id/editar', requireAuth, (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead || !lead.site) return res.status(404).send('Lead ou site nao encontrado.');
  res.render('lead_edit', { lead });
});

app.post('/leads/:id/editar', requireAuth, async (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead || !lead.site) return res.status(404).send('Lead ou site nao encontrado.');

  const { headline, subheadline, aboutText, primaryColor, ctaLabel, ctaMessage, highlights, showGallery, showMap } =
    req.body;

  await store.withDb((d) => {
    const l = d.leads[lead.id];
    l.site = {
      ...l.site,
      headline: headline || l.site.headline,
      subheadline: subheadline || l.site.subheadline,
      aboutText: aboutText || l.site.aboutText,
      primaryColor: /^#[0-9a-fA-F]{6}$/.test(primaryColor || '') ? primaryColor : l.site.primaryColor,
      ctaLabel: ctaLabel || l.site.ctaLabel,
      ctaMessage: ctaMessage || l.site.ctaMessage,
      highlights: String(highlights || '')
        .split('\n')
        .map((h) => h.trim())
        .filter(Boolean),
      showGallery: showGallery === 'on',
      showMap: showMap === 'on',
      updatedAt: new Date().toISOString(),
    };
  });

  res.redirect(`/leads/${lead.id}`);
});

app.post('/leads/:id/aprovar', requireAuth, async (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead) return res.status(404).send('Lead nao encontrado.');
  await store.withDb((d) => {
    d.leads[lead.id].status = 'aprovado';
  });
  res.redirect(`/leads/${lead.id}`);
});

app.post('/leads/:id/descartar', requireAuth, async (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead) return res.status(404).send('Lead nao encontrado.');
  await store.withDb((d) => {
    d.leads[lead.id].status = 'descartado';
  });
  res.redirect('/leads');
});

app.post('/leads/:id/enviar-whatsapp', requireAuth, async (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead) return res.status(404).send('Lead nao encontrado.');
  const { telefone, mensagem } = req.body;

  try {
    await sendWhatsapp({ telefone, mensagem, leadId: lead.id, nomeNegocio: lead.name });
    await store.withDb((d) => {
      const l = d.leads[lead.id];
      l.status = 'enviado_whatsapp';
      l.messages.push({ channel: 'whatsapp', sentAt: new Date().toISOString(), to: telefone, text: mensagem });
    });
    return res.redirect(`/leads/${lead.id}?enviado=whatsapp`);
  } catch (err) {
    return res.redirect(`/leads/${lead.id}?erro=${encodeURIComponent(err.message)}`);
  }
});

app.post('/leads/:id/enviar-email', requireAuth, async (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead) return res.status(404).send('Lead nao encontrado.');
  const { email, assunto, mensagem } = req.body;

  try {
    await sendEmail({ to: email, subject: assunto, text: mensagem });
    await store.withDb((d) => {
      const l = d.leads[lead.id];
      l.status = 'enviado_email';
      l.messages.push({ channel: 'email', sentAt: new Date().toISOString(), to: email, text: mensagem });
    });
    return res.redirect(`/leads/${lead.id}?enviado=email`);
  } catch (err) {
    return res.redirect(`/leads/${lead.id}?erro=${encodeURIComponent(err.message)}`);
  }
});

// ---- preview publica da landing page (link enviado ao lead) ----
app.get('/p/:id', (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead || !lead.site) return res.status(404).send('Previa nao encontrada.');
  res.send(renderLandingPage(lead));
});

app.get('/leads/:id/download', requireAuth, (req, res) => {
  const db = store.load();
  const lead = db.leads[req.params.id];
  if (!lead || !lead.site) return res.status(404).send('Lead ou site nao encontrado.');
  const html = renderLandingPage(lead);
  res.setHeader('Content-Disposition', `attachment; filename="${lead.name.replace(/[^a-z0-9]+/gi, '-')}.html"`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ---- proxy de fotos do Google Places (nao expoe a API key no HTML) ----
app.get('/foto/:reference', async (req, res) => {
  try {
    const { data, contentType } = await places.fetchPhoto(req.params.reference, Number(req.query.maxwidth) || 800);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(data);
  } catch (err) {
    res.status(502).send('Nao foi possivel carregar a foto.');
  }
});

// ---- configuracoes ----
app.get('/configuracoes', requireAuth, (req, res) => {
  const db = store.load();
  res.render('settings', { settings: db.settings, env: envStatus() });
});

app.post('/configuracoes', requireAuth, async (req, res) => {
  const { whatsappTemplate, emailSubject, emailTemplate } = req.body;
  await store.withDb((db) => {
    db.settings.whatsappTemplate = whatsappTemplate;
    db.settings.emailSubject = emailSubject;
    db.settings.emailTemplate = emailTemplate;
  });
  res.redirect('/configuracoes');
});

app.locals.renderTemplate = renderTemplate;

app.listen(PORT, () => {
  console.log(`BuscaDeClientes rodando em http://localhost:${PORT}`);
});
