const axios = require('axios');
const cheerio = require('cheerio');

// Hosts que indicam que o negocio nao tem um site proprio, e sim uma pagina
// generica de rede social, link-in-bio ou "site gratis" de construtor.
const GENERIC_HOST_PATTERNS = [
  /(^|\.)facebook\.com$/,
  /(^|\.)instagram\.com$/,
  /(^|\.)linktr\.ee$/,
  /(^|\.)bio\.link$/,
  /(^|\.)beacons\.ai$/,
  /(^|\.)wa\.me$/,
  /(^|\.)whatsapp\.com$/,
  /(^|\.)business\.site$/, // Google Sites / Google My Business site gratuito
  /(^|\.)wixsite\.com$/,
  /(^|\.)godaddysites\.com$/,
  /(^|\.)blogspot\.com$/,
  /(^|\.)weebly\.com$/,
  /(^|\.)yolasite\.com$/,
  /(^|\.)sites\.google\.com$/,
];

const CATEGORY_PRIORITY = {
  sem_site: 100,
  rede_social: 90,
  fora_do_ar: 85,
  desatualizado: 60,
  ok: 10,
};

function extractHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isGenericHost(hostname) {
  if (!hostname) return false;
  return GENERIC_HOST_PATTERNS.some((re) => re.test(hostname));
}

function findEmails($, html) {
  const emails = new Set();
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const email = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (email) emails.add(email);
  });
  if (emails.size === 0) {
    const match = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (match) emails.add(match[0]);
  }
  return [...emails][0] || null;
}

function findSocialLinks($) {
  const social = {};
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!social.instagram && /instagram\.com\//i.test(href)) social.instagram = href;
    if (!social.facebook && /facebook\.com\//i.test(href)) social.facebook = href;
  });
  return social;
}

// Analisa um site e retorna uma classificacao de o quao "prioritario" ele e
// como lead (score maior = melhor oportunidade de venda de site novo).
async function analyzeWebsite(url) {
  if (!url) {
    return {
      category: 'sem_site',
      score: CATEGORY_PRIORITY.sem_site,
      reasons: ['Nao possui site cadastrado no Google Maps'],
      email: null,
      social: {},
    };
  }

  const hostname = extractHostname(url);
  if (isGenericHost(hostname)) {
    return {
      category: 'rede_social',
      score: CATEGORY_PRIORITY.rede_social,
      reasons: [`Usa apenas ${hostname} como "site" (sem dominio proprio)`],
      email: null,
      social: hostname && hostname.includes('instagram') ? { instagram: url } : hostname && hostname.includes('facebook') ? { facebook: url } : {},
    };
  }

  let response;
  try {
    response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; BuscaDeClientesBot/1.0; +https://deegitalizando.com) DeegitalizandoProspeccao',
      },
    });
  } catch (err) {
    return {
      category: 'fora_do_ar',
      score: CATEGORY_PRIORITY.fora_do_ar,
      reasons: [`Site fora do ar ou nao responde (${err.code || err.message})`],
      email: null,
      social: {},
    };
  }

  if (response.status >= 400) {
    return {
      category: 'fora_do_ar',
      score: CATEGORY_PRIORITY.fora_do_ar,
      reasons: [`Site retornou erro ${response.status} ao ser acessado`],
      email: null,
      social: {},
    };
  }

  const html = String(response.data || '');
  const $ = cheerio.load(html);
  const reasons = [];

  const isHttps = url.startsWith('https://');
  if (!isHttps) reasons.push('Site nao usa certificado de seguranca (HTTPS)');

  const hasViewport = $('meta[name="viewport"]').length > 0;
  if (!hasViewport) reasons.push('Site nao e otimizado para celular (sem meta viewport)');

  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();
  if (visibleText.length < 400) reasons.push('Conteudo muito raso (pagina quase vazia)');

  const title = ($('title').first().text() || '').trim();
  if (!title) reasons.push('Pagina sem titulo definido (ruim para aparecer no Google)');

  const copyrightMatch = html.match(/(?:©|&copy;|copyright)\D{0,10}(20\d{2})/i);
  if (copyrightMatch) {
    const year = parseInt(copyrightMatch[1], 10);
    const currentYear = new Date().getFullYear();
    if (currentYear - year >= 2) {
      reasons.push(`Rodape indica que o site nao e atualizado desde ${year}`);
    }
  }

  const email = findEmails($, html);
  const social = findSocialLinks($);

  let category = 'ok';
  let score = CATEGORY_PRIORITY.ok;
  if (reasons.length > 0) {
    category = 'desatualizado';
    score = Math.min(80, CATEGORY_PRIORITY.desatualizado + reasons.length * 8);
  }

  return { category, score, reasons, email, social };
}

const CATEGORY_LABELS = {
  sem_site: 'Sem site',
  rede_social: 'So rede social',
  fora_do_ar: 'Site fora do ar',
  desatualizado: 'Site desatualizado',
  ok: 'Site em dia',
};

module.exports = { analyzeWebsite, CATEGORY_LABELS, CATEGORY_PRIORITY };
