// Segmentos pre-configurados para a busca. Cada um define:
//  - keyword: termo usado na busca do Google Places (Nearby Search "keyword")
//  - templateFamily: qual layout de landing page usar (ver siteGenerator.js)
//  - color: cor principal padrao sugerida para a landing page (o usuario pode
//    trocar depois na tela de edicao)
//  - ctaLabel: texto do botao principal de WhatsApp na landing page
//  - highlights: "diferenciais" padrao sugeridos (o usuario pode editar depois)
//
// O usuario tambem pode digitar um segmento livre (nao precisa estar nesta
// lista) - nesse caso usamos templateFamily "servico_local" como padrao.

const SEGMENTS = [
  {
    key: 'barbearia',
    label: 'Barbearia',
    keyword: 'barbearia',
    templateFamily: 'servico_local',
    color: '#1f2937',
    ctaLabel: 'Agendar horario no WhatsApp',
    highlights: ['Cortes modernos e classicos', 'Ambiente climatizado', 'Agendamento facil pelo WhatsApp'],
  },
  {
    key: 'salao_beleza',
    label: 'Salao de beleza / Cabeleireiro',
    keyword: 'salao de beleza',
    templateFamily: 'servico_local',
    color: '#be185d',
    ctaLabel: 'Agendar horario no WhatsApp',
    highlights: ['Profissionais especializados', 'Produtos de qualidade', 'Agendamento pelo WhatsApp'],
  },
  {
    key: 'clinica_estetica',
    label: 'Clinica de estetica',
    keyword: 'clinica de estetica',
    templateFamily: 'servico_local',
    color: '#db2777',
    ctaLabel: 'Agendar avaliacao gratuita',
    highlights: ['Tecnologia de ponta', 'Profissionais qualificados', 'Avaliacao gratuita'],
  },
  {
    key: 'academia_personal',
    label: 'Academia / Personal trainer',
    keyword: 'academia',
    templateFamily: 'servico_local',
    color: '#dc2626',
    ctaLabel: 'Quero treinar',
    highlights: ['Estrutura completa', 'Professores qualificados', 'Planos flexiveis'],
  },
  {
    key: 'pet_shop',
    label: 'Pet shop / Banho e tosa',
    keyword: 'pet shop',
    templateFamily: 'servico_local',
    color: '#0d9488',
    ctaLabel: 'Agendar banho e tosa',
    highlights: ['Cuidado e carinho com seu pet', 'Produtos de qualidade', 'Agendamento rapido'],
  },
  {
    key: 'oficina_mecanica',
    label: 'Oficina mecanica / Auto center',
    keyword: 'oficina mecanica',
    templateFamily: 'servico_local',
    color: '#1e3a8a',
    ctaLabel: 'Solicitar orcamento',
    highlights: ['Diagnostico preciso', 'Equipe experiente', 'Orcamento sem compromisso'],
  },
  {
    key: 'buffet_eventos',
    label: 'Buffet / Espaco para eventos',
    keyword: 'buffet de eventos',
    templateFamily: 'servico_local',
    color: '#92400e',
    ctaLabel: 'Solicitar orcamento',
    highlights: ['Espaco versatil', 'Cardapio personalizado', 'Atendimento dedicado'],
  },
  {
    key: 'advogado',
    label: 'Advogado / Escritorio de advocacia',
    keyword: 'advogado',
    templateFamily: 'profissional_liberal',
    color: '#1e293b',
    ctaLabel: 'Falar com um advogado',
    highlights: ['Atendimento personalizado', 'Anos de experiencia', 'Sigilo e confianca'],
  },
  {
    key: 'contador',
    label: 'Contador / Contabilidade',
    keyword: 'escritorio de contabilidade',
    templateFamily: 'profissional_liberal',
    color: '#0f766e',
    ctaLabel: 'Falar com um contador',
    highlights: ['Atendimento consultivo', 'Suporte para MEI e empresas', 'Agilidade nas obrigacoes'],
  },
  {
    key: 'dentista',
    label: 'Dentista / Clinica odontologica',
    keyword: 'clinica odontologica',
    templateFamily: 'profissional_liberal',
    color: '#0284c7',
    ctaLabel: 'Agendar consulta',
    highlights: ['Tecnologia moderna', 'Equipe qualificada', 'Atendimento humanizado'],
  },
  {
    key: 'fisioterapeuta',
    label: 'Fisioterapeuta / Clinica de fisioterapia',
    keyword: 'clinica de fisioterapia',
    templateFamily: 'profissional_liberal',
    color: '#0891b2',
    ctaLabel: 'Agendar avaliacao',
    highlights: ['Tratamento individualizado', 'Equipamentos modernos', 'Foco em resultados'],
  },
  {
    key: 'nutricionista',
    label: 'Nutricionista',
    keyword: 'nutricionista',
    templateFamily: 'profissional_liberal',
    color: '#65a30d',
    ctaLabel: 'Agendar consulta',
    highlights: ['Plano alimentar personalizado', 'Acompanhamento continuo', 'Atendimento online ou presencial'],
  },
  {
    key: 'psicologo',
    label: 'Psicologo / Clinica de psicologia',
    keyword: 'psicologo',
    templateFamily: 'profissional_liberal',
    color: '#7c3aed',
    ctaLabel: 'Agendar sessao',
    highlights: ['Ambiente acolhedor', 'Sigilo profissional', 'Atendimento online ou presencial'],
  },
  {
    key: 'arquitetura_design',
    label: 'Arquitetura / Design de interiores',
    keyword: 'escritorio de arquitetura',
    templateFamily: 'profissional_liberal',
    color: '#111827',
    ctaLabel: 'Solicitar orcamento',
    highlights: ['Projetos personalizados', 'Do conceito a execucao', 'Portfolio premiado'],
  },
  {
    key: 'imobiliaria',
    label: 'Imobiliaria / Corretor de imoveis',
    keyword: 'imobiliaria',
    templateFamily: 'comercio_local',
    color: '#065f46',
    ctaLabel: 'Falar com um corretor',
    highlights: ['Imoveis selecionados', 'Atendimento especializado', 'Suporte em toda negociacao'],
  },
  {
    key: 'restaurante',
    label: 'Restaurante / Lanchonete',
    keyword: 'restaurante',
    templateFamily: 'comercio_local',
    color: '#b91c1c',
    ctaLabel: 'Fazer pedido no WhatsApp',
    highlights: ['Ingredientes selecionados', 'Ambiente agradavel', 'Delivery pelo WhatsApp'],
  },
  {
    key: 'loja_roupas',
    label: 'Loja de roupas / Comercio local',
    keyword: 'loja de roupas',
    templateFamily: 'comercio_local',
    color: '#d97706',
    ctaLabel: 'Ver novidades no WhatsApp',
    highlights: ['Novidades toda semana', 'Atendimento personalizado', 'Compre pelo WhatsApp'],
  },
];

function getSegments() {
  return SEGMENTS;
}

function getSegment(key) {
  return SEGMENTS.find((s) => s.key === key);
}

// Usado quando o usuario digita um segmento/termo que nao esta na lista.
function customSegment(keyword) {
  const label = keyword.charAt(0).toUpperCase() + keyword.slice(1);
  return {
    key: 'personalizado',
    label,
    keyword,
    templateFamily: 'servico_local',
    color: '#2563eb',
    ctaLabel: 'Falar no WhatsApp',
    highlights: ['Atendimento de qualidade', 'Profissionais experientes', 'Fale conosco pelo WhatsApp'],
  };
}

module.exports = { getSegments, getSegment, customSegment };
