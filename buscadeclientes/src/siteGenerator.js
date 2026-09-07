// Gera o HTML de uma landing page de previa para um lead, usando os dados
// capturados do Google Maps (e opcionalmente do site/redes sociais dele) mais
// a customizacao feita pelo usuario na tela de edicao (lead.site).
//
// O HTML e auto-contido (CSS inline, sem dependencias externas alem de uma
// fonte do Google Fonts), para poder ser baixado como arquivo .html avulso e
// hospedado em qualquer lugar quando o cliente fechar negocio.

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function lighten(hex, amount) {
  const h = hex.replace('#', '');
  const num = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = Math.min(255, (num >> 16) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `#${[r, g, b].map((v) => Math.max(0, v).toString(16).padStart(2, '0')).join('')}`;
}

function buildWhatsappLink(phoneDigits, message) {
  if (!phoneDigits) return null;
  return `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`;
}

function renderStars(rating) {
  if (!rating) return '';
  const full = Math.round(rating);
  return '★★★★★☆☆☆☆☆'.slice(5 - full, 10 - full).padEnd(5, '☆');
}

function renderLandingPage(lead) {
  const site = lead.site || {};
  const primary = site.primaryColor || '#2563eb';
  const primaryDark = lighten(primary, -30);
  const primaryLight = lighten(primary, 40);
  const ctaMessage = site.ctaMessage || `Ola! Vi a pagina de voces e quero saber mais.`;
  const waLink = buildWhatsappLink(lead.phoneDigits, ctaMessage);

  const photos = (lead.photoRefs || []).slice(0, 6);
  const highlights = (site.highlights && site.highlights.length ? site.highlights : ['Atendimento de qualidade']);
  const reviews = (lead.reviews || []).slice(0, 3);
  const hours = lead.openingHoursText || [];

  const gallerySection = site.showGallery && photos.length
    ? `
    <section class="section gallery">
      <h2>Conheca um pouco mais</h2>
      <div class="gallery-grid">
        ${photos.map((ref) => `<div class="photo"><img src="/foto/${encodeURIComponent(ref)}?maxwidth=700" alt="${escapeHtml(lead.name)}" loading="lazy" /></div>`).join('')}
      </div>
    </section>`
    : '';

  const reviewsSection = reviews.length
    ? `
    <section class="section reviews">
      <h2>O que dizem os clientes</h2>
      <div class="reviews-grid">
        ${reviews
          .map(
            (r) => `
        <div class="review-card">
          <div class="stars">${renderStars(r.rating)}</div>
          <p>&ldquo;${escapeHtml((r.text || '').slice(0, 220))}${(r.text || '').length > 220 ? '...' : ''}&rdquo;</p>
          <span class="review-author">${escapeHtml(r.author_name || 'Cliente')}</span>
        </div>`
          )
          .join('')}
      </div>
    </section>`
    : '';

  const hoursHtml = hours.length
    ? `<ul class="hours-list">${hours.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`
    : '<p class="muted">Horario de funcionamento sob consulta.</p>';

  const mapSection = site.showMap !== false && lead.address
    ? `
        <div class="map-embed">
          <iframe
            src="https://www.google.com/maps?q=${encodeURIComponent(lead.address)}&output=embed"
            loading="lazy"
            referrerpolicy="no-referrer-when-downgrade"
          ></iframe>
        </div>`
    : '';

  const ratingHtml = lead.rating
    ? `<div class="hero-rating"><span class="stars">${renderStars(lead.rating)}</span> ${lead.rating.toFixed
        ? lead.rating.toFixed(1)
        : lead.rating} ${lead.userRatingsTotal ? `(${lead.userRatingsTotal} avaliacoes no Google)` : ''}</div>`
    : '';

  const ctaButton = waLink
    ? `<a class="cta" href="${waLink}" target="_blank" rel="noopener">${escapeHtml(site.ctaLabel || 'Falar no WhatsApp')}</a>`
    : `<span class="cta cta-disabled">${escapeHtml(site.ctaLabel || 'Falar no WhatsApp')}</span>`;

  return `<!doctype html>
<html lang="pt-BR" style="--primary:${primary}; --primary-dark:${primaryDark}; --primary-light:${primaryLight};">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(lead.name)}${lead.city ? ` - ${escapeHtml(lead.city)}` : ''}</title>
<meta name="description" content="${escapeHtml(site.subheadline || site.headline || lead.name)}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: #1f2937; background: #fff; line-height: 1.6; }
  h1, h2, h3 { font-family: 'Poppins', sans-serif; margin: 0 0 .5em; }
  img { max-width: 100%; display: block; }
  .section { padding: 64px 24px; max-width: 1100px; margin: 0 auto; }
  .section h2 { text-align: center; font-size: 2rem; margin-bottom: 40px; color: var(--primary-dark); }
  .hero { background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: #fff; padding: 90px 24px 80px; text-align: center; }
  .hero-inner { max-width: 780px; margin: 0 auto; }
  .badge { display: inline-block; background: rgba(255,255,255,.15); padding: 6px 16px; border-radius: 999px; font-size: .8rem; letter-spacing: .03em; margin-bottom: 24px; }
  .hero h1 { font-size: clamp(1.9rem, 4vw, 3rem); line-height: 1.15; }
  .hero .subheadline { font-size: 1.15rem; opacity: .92; max-width: 600px; margin: 16px auto 32px; }
  .hero-rating { margin-bottom: 24px; font-size: 1rem; opacity: .95; }
  .stars { color: #fbbf24; letter-spacing: 2px; }
  .cta { display: inline-block; background: #fff; color: var(--primary-dark); font-weight: 700; padding: 16px 36px; border-radius: 999px; text-decoration: none; font-size: 1.05rem; box-shadow: 0 10px 30px rgba(0,0,0,.15); transition: transform .15s ease; }
  .cta:hover { transform: translateY(-2px); }
  .cta-disabled { opacity: .6; cursor: not-allowed; }
  .highlights .grid { max-width: 1100px; margin: 0 auto; padding: 56px 24px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 24px; }
  .highlights .card { background: var(--primary-light); border-radius: 16px; padding: 28px 20px; text-align: center; font-weight: 600; color: var(--primary-dark); }
  .gallery-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .photo { border-radius: 14px; overflow: hidden; aspect-ratio: 4/3; }
  .photo img { width: 100%; height: 100%; object-fit: cover; }
  .about p { font-size: 1.1rem; max-width: 760px; margin: 0 auto; text-align: center; color: #374151; }
  .reviews-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 24px; }
  .review-card { background: #f9fafb; border-radius: 14px; padding: 24px; }
  .review-author { display: block; margin-top: 12px; font-weight: 600; color: var(--primary-dark); font-size: .9rem; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: start; }
  .hours-list { list-style: none; padding: 0; margin: 0; }
  .hours-list li { padding: 6px 0; border-bottom: 1px solid #e5e7eb; font-size: .95rem; }
  .muted { color: #6b7280; }
  .map-embed iframe { width: 100%; height: 280px; border: 0; border-radius: 14px; }
  .address { margin-top: 12px; color: #4b5563; }
  .cta-footer { background: var(--primary-dark); color: #fff; text-align: center; padding: 70px 24px; }
  .cta-footer h2 { color: #fff; }
  .cta-footer .disclaimer { margin-top: 28px; font-size: .8rem; opacity: .7; }
  @media (max-width: 720px) {
    .info-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <header class="hero">
    <div class="hero-inner">
      <span class="badge">Previa exclusiva preparada para ${escapeHtml(lead.name)}</span>
      <h1>${escapeHtml(site.headline || lead.name)}</h1>
      <p class="subheadline">${escapeHtml(site.subheadline || '')}</p>
      ${ratingHtml}
      ${ctaButton}
    </div>
  </header>

  <section class="highlights">
    <div class="grid">
      ${highlights.map((h) => `<div class="card">${escapeHtml(h)}</div>`).join('')}
    </div>
  </section>

  ${gallerySection}

  <section class="section about">
    <h2>Sobre ${escapeHtml(lead.name)}</h2>
    <p>${escapeHtml(site.aboutText || `${lead.name} atende com dedicacao a regiao${lead.city ? ` de ${lead.city}` : ''}, buscando sempre a satisfacao de quem confia no nosso trabalho.`)}</p>
  </section>

  ${reviewsSection}

  <section class="section info">
    <h2>Onde estamos</h2>
    <div class="info-grid">
      <div>
        <h3>Horario de funcionamento</h3>
        ${hoursHtml}
        <p class="address">${escapeHtml(lead.address || '')}</p>
        ${lead.googleMapsUrl ? `<p><a href="${lead.googleMapsUrl}" target="_blank" rel="noopener">Ver no Google Maps &rarr;</a></p>` : ''}
      </div>
      ${mapSection}
    </div>
  </section>

  <footer class="cta-footer">
    <h2>Vamos conversar?</h2>
    ${ctaButton}
    <p class="disclaimer">Previa de site criada por Deegitalizando &middot; Agencia de Marketing Digital</p>
  </footer>
</body>
</html>`;
}

// Monta a customizacao inicial (default) da landing page a partir dos dados
// do lead + do segmento escolhido na busca. O usuario pode editar tudo isso
// depois na tela de edicao.
function buildDefaultSite(lead, segment) {
  const cityPart = lead.city ? ` em ${lead.city}` : '';
  return {
    headline: `${lead.name}`,
    subheadline: `Referencia em ${segment ? segment.label.toLowerCase() : 'atendimento'}${cityPart}. Fale com a gente e agende pelo WhatsApp.`,
    aboutText: `${lead.name} atende com dedicacao${cityPart}, buscando sempre a satisfacao de quem confia no nosso trabalho.`,
    primaryColor: (segment && segment.color) || '#2563eb',
    ctaLabel: (segment && segment.ctaLabel) || 'Falar no WhatsApp',
    ctaMessage: `Ola! Vi a pagina de voces e quero saber mais.`,
    highlights: (segment && segment.highlights) || ['Atendimento de qualidade'],
    showGallery: true,
    showMap: true,
    slug: lead.id,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { renderLandingPage, buildDefaultSite, escapeHtml };
