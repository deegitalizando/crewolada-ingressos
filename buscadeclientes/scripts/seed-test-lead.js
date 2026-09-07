// Script auxiliar so para teste manual: injeta um lead falso no banco (sem
// depender da API do Google) para validar o fluxo de gerar site / editar /
// preview / download.
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const store = require('../src/store');

async function main() {
  const searchId = uuidv4();
  const leadId = uuidv4();

  await store.withDb((db) => {
    db.searches[searchId] = {
      id: searchId,
      segmentKey: 'barbearia',
      segmentLabel: 'Barbearia',
      templateFamily: 'servico_local',
      keyword: 'barbearia',
      radiusKm: 5,
      location: { query: 'Bangu, Rio de Janeiro - RJ', lat: -22.88, lng: -43.46, formattedAddress: 'Bangu, Rio de Janeiro - RJ' },
      status: 'concluida',
      totalFound: 1,
      processedCount: 1,
      leadIds: [leadId],
      createdAt: new Date().toISOString(),
    };
    db.leads[leadId] = {
      id: leadId,
      searchId,
      placeId: 'fake-place-id',
      name: 'Barbearia do Ze',
      segmentKey: 'barbearia',
      segmentLabel: 'Barbearia',
      templateFamily: 'servico_local',
      address: 'Rua Fake, 123 - Bangu, Rio de Janeiro - RJ, 21810-000, Brasil',
      city: 'Rio de Janeiro',
      phone: '(21) 99999-8888',
      phoneDigits: '5521999998888',
      website: null,
      googleMapsUrl: 'https://maps.google.com/?cid=123',
      rating: 4.7,
      userRatingsTotal: 132,
      openingHoursText: ['segunda-feira: 09:00 - 20:00', 'terca-feira: 09:00 - 20:00'],
      photoRefs: [],
      location: { lat: -22.88, lng: -43.46 },
      businessStatus: 'OPERATIONAL',
      email: null,
      social: {},
      reviews: [{ author_name: 'Joao', rating: 5, text: 'Melhor barbearia da regiao!' }],
      analysis: { category: 'sem_site', score: 100, reasons: ['Nao possui site cadastrado no Google Maps'] },
      status: 'novo',
      site: null,
      messages: [],
      createdAt: new Date().toISOString(),
    };
  });

  console.log('Lead de teste criado:', leadId);
  console.log(`Acesse http://localhost:${process.env.PORT || 3100}/leads/${leadId}`);
}

main();
