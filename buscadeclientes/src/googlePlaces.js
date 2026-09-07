const axios = require('axios');

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const NEARBY_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const PHOTO_URL = 'https://maps.googleapis.com/maps/api/place/photo';

function apiKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || key === 'SUA_CHAVE_AQUI') {
    throw new Error(
      'GOOGLE_MAPS_API_KEY nao configurada. Defina no .env (veja .env.example) com uma chave que tenha ' +
        '"Geocoding API" e "Places API" habilitadas no Google Cloud Console.'
    );
  }
  return key;
}

// Converte um texto de endereco/cidade em lat/lng.
async function geocode(query) {
  const { data } = await axios.get(GEOCODE_URL, {
    params: { address: query, key: apiKey(), language: 'pt-BR', region: 'br' },
    timeout: 10000,
  });
  if (data.status !== 'OK' || !data.results.length) {
    throw new Error(`Nao foi possivel localizar "${query}" (Google retornou: ${data.status}).`);
  }
  const result = data.results[0];
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Busca negocios proximos a um ponto usando uma palavra-chave livre.
// Retorna ate 3 paginas (60 resultados) do Google Places Nearby Search.
async function nearbySearch({ lat, lng, radiusMeters, keyword, maxPages = 1 }) {
  const results = [];
  let pageToken = null;
  let page = 0;

  do {
    const params = {
      location: `${lat},${lng}`,
      radius: Math.min(radiusMeters, 50000),
      keyword,
      language: 'pt-BR',
      key: apiKey(),
    };
    if (pageToken) params.pagetoken = pageToken;

    // O Google exige um pequeno atraso antes que o pagetoken fique valido.
    if (pageToken) await sleep(2000);

    const { data } = await axios.get(NEARBY_URL, { params, timeout: 10000 });
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places retornou erro: ${data.status} ${data.error_message || ''}`.trim());
    }
    results.push(...(data.results || []));
    pageToken = data.next_page_token || null;
    page += 1;
  } while (pageToken && page < maxPages);

  return results;
}

const REVIEW_FIELDS = ['rating', 'user_ratings_total', 'reviews'];
const BASE_FIELDS = [
  'name',
  'formatted_address',
  'formatted_phone_number',
  'international_phone_number',
  'website',
  'url',
  'geometry',
  'opening_hours',
  'photos',
  'business_status',
  'rating',
  'user_ratings_total',
];

async function placeDetails(placeId) {
  const includeReviews = String(process.env.INCLUDE_REVIEWS || 'false').toLowerCase() === 'true';
  const fields = includeReviews ? [...BASE_FIELDS, ...REVIEW_FIELDS] : BASE_FIELDS;
  const { data } = await axios.get(DETAILS_URL, {
    params: {
      place_id: placeId,
      fields: [...new Set(fields)].join(','),
      language: 'pt-BR',
      key: apiKey(),
    },
    timeout: 10000,
  });
  if (data.status !== 'OK') {
    throw new Error(`Nao foi possivel obter detalhes do local: ${data.status}`);
  }
  return data.result;
}

// Monta a URL da nossa rota de proxy (para nao expor a chave do Google no
// HTML enviado ao navegador do lead/prospect).
function localPhotoUrl(photoReference, maxwidth = 1000) {
  return `/foto/${encodeURIComponent(photoReference)}?maxwidth=${maxwidth}`;
}

// Usado pela rota de proxy para buscar o binario da foto no Google.
async function fetchPhoto(photoReference, maxwidth = 1000) {
  const response = await axios.get(PHOTO_URL, {
    params: { photoreference: photoReference, maxwidth, key: apiKey() },
    responseType: 'arraybuffer',
    timeout: 10000,
    maxRedirects: 5,
  });
  return { data: response.data, contentType: response.headers['content-type'] || 'image/jpeg' };
}

module.exports = { geocode, nearbySearch, placeDetails, localPhotoUrl, fetchPhoto };
