const { v4: uuidv4 } = require('uuid');
const store = require('./store');
const places = require('./googlePlaces');
const { analyzeWebsite } = require('./siteAnalyzer');
const { normalizePhone } = require('./messaging');

function guessCity(formattedAddress, fallback) {
  if (!formattedAddress) return fallback || '';
  // Formato tipico do Google no Brasil: "Rua X, 123 - Bairro, Cidade - UF, 00000-000, Brasil"
  const match = formattedAddress.match(/,\s*([^,]+?)\s*-\s*[A-Z]{2},/);
  if (match) return match[1].trim();
  const parts = formattedAddress.split(',').map((p) => p.trim());
  return parts.length >= 2 ? parts[parts.length - 3] || fallback : fallback || '';
}

async function processSearch(searchId) {
  try {
    const search = store.load().searches[searchId];
    if (!search) return;

    const maxPages = Math.min(3, Math.max(1, Number(process.env.PLACES_MAX_PAGES || 1)));
    const radiusMeters = search.radiusKm * 1000;

    const results = await places.nearbySearch({
      lat: search.location.lat,
      lng: search.location.lng,
      radiusMeters,
      keyword: search.keyword,
      maxPages,
    });

    await store.withDb((db) => {
      db.searches[searchId].totalFound = results.length;
    });

    for (const result of results) {
      try {
        const details = await places.placeDetails(result.place_id);
        const website = details.website || null;
        const analysis = await analyzeWebsite(website);

        const lead = {
          id: uuidv4(),
          searchId,
          placeId: result.place_id,
          name: details.name,
          segmentKey: search.segmentKey,
          segmentLabel: search.segmentLabel,
          templateFamily: search.templateFamily,
          address: details.formatted_address || '',
          city: guessCity(details.formatted_address, search.location.query),
          phone: details.formatted_phone_number || details.international_phone_number || '',
          phoneDigits: normalizePhone(details.formatted_phone_number || details.international_phone_number),
          website,
          googleMapsUrl: details.url || null,
          rating: details.rating || null,
          userRatingsTotal: details.user_ratings_total || 0,
          openingHoursText: (details.opening_hours && details.opening_hours.weekday_text) || [],
          photoRefs: (details.photos || []).slice(0, 6).map((p) => p.photo_reference),
          location: details.geometry ? details.geometry.location : null,
          businessStatus: details.business_status || null,
          email: analysis.email,
          social: analysis.social || {},
          reviews: (details.reviews || []).map((r) => ({
            author_name: r.author_name,
            rating: r.rating,
            text: r.text,
          })),
          analysis: { category: analysis.category, score: analysis.score, reasons: analysis.reasons },
          status: 'novo',
          site: null,
          messages: [],
          createdAt: new Date().toISOString(),
        };

        await store.withDb((db) => {
          db.leads[lead.id] = lead;
          db.searches[searchId].leadIds.push(lead.id);
          db.searches[searchId].processedCount += 1;
        });
      } catch (err) {
        console.error(`Falha ao processar lugar ${result.place_id}:`, err.message);
        await store.withDb((db) => {
          db.searches[searchId].processedCount += 1;
          db.searches[searchId].errors = db.searches[searchId].errors || [];
          db.searches[searchId].errors.push(`${result.name || result.place_id}: ${err.message}`);
        });
      }
    }

    await store.withDb((db) => {
      db.searches[searchId].status = 'concluida';
      db.searches[searchId].finishedAt = new Date().toISOString();
    });
  } catch (err) {
    console.error(`Busca ${searchId} falhou:`, err.message);
    await store.withDb((db) => {
      if (db.searches[searchId]) {
        db.searches[searchId].status = 'erro';
        db.searches[searchId].error = err.message;
      }
    });
  }
}

module.exports = { processSearch };
