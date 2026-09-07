# BuscaDeClientes

Ferramenta de prospeccao de clientes para a Deegitalizando (agencia de marketing digital: sites, agente de IA no WhatsApp e trafego pago).

Ela faz o fluxo completo:

1. Voce escolhe um **segmento** (barbearia, salao, advogado, dentista, etc, ou digita qualquer termo) e uma **regiao + raio em km**.
2. A ferramenta busca os negocios no Google Maps (Places API) naquela area.
3. Para cada negocio, ela analisa o site (quando existe) e classifica em: **sem site**, **so rede social/link genérico**, **site fora do ar**, **site desatualizado** ou **site em dia** — priorizando quem mais precisa de um site novo.
4. Para qualquer lead, voce clica em **"Gerar landing page"** e ela monta uma pagina de previa profissional (layout de acordo com o segmento), usando nome, endereco, telefone, avaliacoes, fotos e horario de funcionamento capturados do proprio Google Maps do negocio.
5. Voce pode **editar** a previa (titulo, textos, cor, diferenciais), **aprovar** e depois **enviar por WhatsApp** e/ou **e-mail** (quando um e-mail for encontrado no site do lead), com uma mensagem oferecendo os servicos e o link da previa.
6. A previa tambem pode ser **baixada como um `.html` avulso**, pronta pra hospedar em qualquer lugar quando o cliente fechar negocio.

Este app e independente do restante deste repositorio (que e o sistema de ingressos da Crewolada) — ele tem seu proprio `package.json`, `.env` e processo. A ideia e rodar em outra porta e ser publicado em `deegitalizando.com/buscadeclientes` via proxy reverso.

## Como rodar

```bash
cd buscadeclientes
npm install
cp .env.example .env
```

Edite o `.env` (veja a tabela abaixo) e rode:

```bash
npm start
```

Acesse `http://localhost:3100`, faca login com `ADMIN_LOGIN`/`ADMIN_PASSWORD` (defina algo forte no `.env`, os valores de exemplo sao so placeholder).

## Variaveis de ambiente

| Variavel | Descricao |
|---|---|
| `PORT` | Porta em que o app roda (padrao 3100, para nao brigar com o app de ingressos que usa 3000). |
| `BASE_URL` | URL publica final da ferramenta (ex: `https://deegitalizando.com/buscadeclientes`). Usada para montar o link de previa enviado ao lead. |
| `ADMIN_LOGIN` / `ADMIN_PASSWORD` | Login simples para acessar a ferramenta (a unica rota publica é a previa `/p/:id`, que é a que voce compartilha com o lead). |
| `GOOGLE_MAPS_API_KEY` | Chave do Google Maps Platform (veja abaixo como conseguir). |
| `PLACES_PAGE_SIZE` | Nao usado diretamente pela API (o Google sempre retorna ate 20 por pagina), mantido como referencia. |
| `PLACES_MAX_PAGES` | Quantas paginas de resultado buscar por busca (1 pagina = ate 20 negocios, max 3 = 60). Mais paginas = mais chamadas pagas ao Google. |
| `INCLUDE_REVIEWS` | Se `true`, tambem busca avaliacoes/reviews do Google (campo cobrado a parte pelo Google - "Atmosphere Data"). Deixe `false` para economizar. |
| `MESSAGING_MODE` | `n8n` (recomendado) ou `evolution_direct` — veja secao de WhatsApp abaixo. |
| `N8N_PROSPECCAO_WHATSAPP_WEBHOOK_URL` | Webhook do n8n usado quando `MESSAGING_MODE=n8n`. |
| `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` / `EVOLUTION_INSTANCE` | Usados quando `MESSAGING_MODE=evolution_direct` (chama a Evolution API direto, sem passar pelo n8n). |
| `DEFAULT_COUNTRY_CODE` | DDI para normalizar telefones (Brasil = `55`). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Envio de e-mail (opcional, so usado quando a ferramenta encontra um e-mail no site do lead). |

## Conseguindo a chave do Google Maps

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/), crie (ou use) um projeto.
2. Ative o faturamento (o Google exige cartao, mas da um credito mensal gratuito — veja custos abaixo).
3. Em "APIs e servicos", ative: **Geocoding API** e **Places API** (a versao "legada", que é a que este app usa).
4. Crie uma credencial do tipo "Chave de API" e cole em `GOOGLE_MAPS_API_KEY`.
5. Restrinja a chave por IP (o IP da sua VPS) para seguranca, e limite as APIs que ela pode chamar as duas acima.

**Custos aproximados (tabela do Google, pode mudar):** Nearby Search e Geocoding ficam na faixa de ~US$0,032 por chamada; Place Details (Basic) é gratuito, mas os campos de telefone/site/foto ficam na categoria "Contact Data" (~US$0,003 cada) e avaliacoes/nota na categoria "Atmosphere Data" (~US$0,005 cada, so cobrado se `INCLUDE_REVIEWS=true`). Ou seja, uma busca de 20 resultados custa perto de 20 x (Nearby Search + Contact Data), o que fica bem barato (poucos centavos de dolar por busca), mas vale acompanhar o painel de faturamento do Google nos primeiros dias de uso.

## Integrando o envio de WhatsApp com seu n8n + Evolution API

Como voce ja tem n8n e Evolution API rodando na VPS (o mesmo padrao usado no app de ingressos, veja `src/n8n.js` na raiz deste repositorio), o jeito mais simples é criar **um novo workflow no n8n**, parecido com o "WORKFLOW CREWOLADA" que ja existe:

1. Node **Webhook** (metodo POST), path por exemplo `buscadeclientes-whatsapp`. Ele vai receber:
   ```json
   { "telefone": "5521999998888", "mensagem": "texto da mensagem...", "leadId": "...", "nomeNegocio": "..." }
   ```
2. Node da **Evolution API** ("Send Text"), usando a mesma credencial/instancia que voce ja usa, mapeando `number` = `{{ $json.telefone }}` e `text` = `{{ $json.mensagem }}`.
3. Copie a URL do webhook (producao) e cole em `N8N_PROSPECCAO_WHATSAPP_WEBHOOK_URL` no `.env`.

Se preferir nao passar pelo n8n, defina `MESSAGING_MODE=evolution_direct` e preencha `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_INSTANCE` — a ferramenta chama `POST {EVOLUTION_API_URL}/message/sendText/{EVOLUTION_INSTANCE}` diretamente.

## Publicando em deegitalizando.com/buscadeclientes

Rode o app como um processo separado (ex: PM2 ou o `Dockerfile` incluso, na porta `3100`) e configure o nginx (ou o proxy do EasyPanel/Traefik que voce ja usa) para redirecionar o caminho, removendo o prefixo:

```nginx
location /buscadeclientes/ {
    proxy_pass http://127.0.0.1:3100/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Repare na barra final em `proxy_pass http://127.0.0.1:3100/` — ela é o que faz o nginx remover o prefixo `/buscadeclientes` antes de repassar pro app. Lembre de manter `BASE_URL=https://deegitalizando.com/buscadeclientes` no `.env` de producao.

## Como funciona a classificacao "sem site / desatualizado / etc"

E uma heuristica (nao é 100% precisa, mas é um bom filtro inicial — a decisao final é sempre sua, olhando a lista):

- **Sem site**: o Google Maps do negocio nao tem nenhum site cadastrado.
- **So rede social**: o "site" cadastrado é uma pagina do Instagram/Facebook, Linktree, ou um site gratuito tipo Google Sites/Wix free/Blogspot (sem dominio proprio).
- **Site fora do ar**: a URL nao responde ou retorna erro.
- **Site desatualizado**: o site existe mas tem sinais de problema (sem HTTPS, nao é responsivo para celular, conteudo muito raso, rodape com copyright de anos atras).
- **Site em dia**: nao foram encontrados problemas — esses ficam escondidos por padrao na lista de leads (mas aparecem se voce filtrar por "Site em dia" na tela de Leads).

Cada lead mostra os motivos especificos encontrados, entao voce sempre pode conferir manualmente antes de decidir prospectar.

## Limitacoes conhecidas / proximos passos

- A analise de "site desatualizado" é heuristica; sempre vale uma olhada manual antes de enviar a mensagem.
- Nao ha scraping de Instagram/Facebook (login bloqueia isso) — a ferramenta so pega o link, quando existe, para voce conferir manualmente.
- O Google Places Nearby Search tem raio maximo de 50km e ate 60 resultados por busca (3 paginas) — para regioes muito grandes ou nichos muito comuns, faca buscas mais especificas (bairro por bairro).
- O banco de dados é um arquivo JSON simples (`data/db.json`), suficiente para o volume de uma agencia; se o uso crescer muito, vale migrar para um banco de verdade (Postgres/SQLite).
- Sessao de login fica em memoria (reiniciar o processo desloga todo mundo).
- Ideias de evolucao: fila de leads em formato kanban (novo &rarr; contatado &rarr; negociando &rarr; fechado), textos da landing page gerados por IA a partir das fotos/reviews reais, disparo automatico de uma sequencia de follow-up via n8n, e um botao para já criar a campanha de trafego pago (Meta/Google Ads) a partir do mesmo lead.
