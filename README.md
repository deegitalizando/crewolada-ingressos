# Crewolada - Ingressos

Sistema de venda de ingressos por lotes, com QR code, numeracao para sorteio, PDF do ingresso, checkout embutido via Mercado Pago, validador de entrada e painel de vendas com lembretes automaticos.

## Como rodar

```bash
npm install
cp .env.example .env
```

Edite o `.env` com seus dados (veja abaixo) e depois:

```bash
npm start
```

O site sobe em `http://localhost:3000`.

## Variaveis de ambiente

| Variavel | Descricao |
|---|---|
| `BASE_URL` | URL publica do site (sem barra no final). Precisa ser HTTPS publico para o Mercado Pago conseguir chamar o webhook. |
| `EVENT_NAME`, `EVENT_DATE_LABEL`, `EVENT_VENUE` | Textos exibidos na pagina de venda e no PDF do ingresso. |
| `MAX_QTY_PER_ORDER` | Limite de ingressos por pedido. |
| `MP_ACCESS_TOKEN` | Access token do Mercado Pago. Use um token `TEST-...` para testar em sandbox. |
| `MP_PUBLIC_KEY` | Public Key da mesma aplicacao Mercado Pago, usada no navegador pelo Payment Brick (checkout embutido). |
| `MP_WEBHOOK_SECRET` | Chave secreta do webhook (Mercado Pago > Suas integracoes > Webhooks). Recomendado em producao. |
| `N8N_WEBHOOK_URL` | Webhook do n8n que envia o ingresso (PDF) por WhatsApp e e-mail. |
| `N8N_BROADCAST_WEBHOOK_URL` | Webhook do n8n usado pelo painel `/vendas` para disparo em massa. |
| `N8N_REMINDER_WEBHOOK_URL` | Webhook do n8n usado pelos lembretes automaticos agendados em `/vendas/mensagens`. |
| `VALIDATOR_PASSWORD` | Senha de acesso do validador (`/validador`). |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | Login e senha do painel de vendas (`/vendas`). |
| `DEFAULT_COUNTRY_CODE` | DDI usado para normalizar o telefone (Brasil = `55`). |

Os **lotes** (quantidade e preco de cada faixa) nao ficam no `.env` — sao definidos em [src/lotes.js](src/lotes.js), porque o preco muda sozinho conforme os ingressos vao sendo vendidos.

## Fluxo de compra

1. Comprador acessa `/`, ve o preco do lote atual e escolhe a quantidade (+/-). Ao clicar em "Garantir meu ingresso" vai para `/checkout/dados`.
2. Preenche nome, e-mail, WhatsApp e CPF, clica em "Continuar para o pagamento" — so entao o Payment Brick do Mercado Pago e criado, ja com e-mail/CPF pre-preenchidos (evita pedir os mesmos dados duas vezes). Paga com cartao ou Pix sem sair do site.
3. O pagamento e criado via `POST /api/pagamentos`. Se aprovado na hora (cartao), os ingressos ja saem gerados. Se ficar pendente (Pix), o Mercado Pago chama `POST /api/webhooks/mercadopago` quando o status mudar.
4. Cada ingresso recebe um **numero sequencial de sorteio** (nunca se repete, cresce a cada ingresso vendido — util para sorteios no evento), QR code e PDF, enviados por WhatsApp e e-mail via n8n.
5. O comprador acompanha em `/pedido/:id` (atualiza sozinho) e ve cada ingresso em `/ingresso/:codigo`, com botoes para imprimir ou compartilhar o PDF.
6. Na entrada do evento, a equipe acessa `/validador` (nao ha link publico para essa pagina — precisa digitar a URL), entra com `VALIDATOR_PASSWORD` e escaneia o QR code. A cada validacao toca um bipe e uma voz anuncia o horario exato (Brasilia) em que o ingresso foi lido.

## Painel de vendas (`/vendas`)

Login com `ADMIN_LOGIN` / `ADMIN_PASSWORD`. Mostra faturamento, ingressos vendidos por lote e a lista de compradores (nome, e-mail, WhatsApp, CPF, status). Tem tambem um disparo em massa de WhatsApp para todos os contatos da Evolution API, reaproveitando o recurso de variacao de mensagens via IA (para reduzir risco de bloqueio por spam).

### Aba "E-mail e WhatsApp" (`/vendas/mensagens`)

Permite configurar:
- Uma mensagem personalizada opcional para a confirmacao de compra (substitui o texto padrao enviado com o ingresso).
- A data/hora de inicio do evento (horario de Brasilia).
- Quatro lembretes automaticos, enviados uma unica vez para todos os compradores pagos: **5 dias antes**, **1 dia antes**, **no dia do evento** (09h) e **1 hora antes**. Use `{{nome}}` no texto para personalizar.

O envio dos lembretes e verificado a cada 5 minutos pelo processo do servidor; uma vez enviado, cada lembrete fica marcado como "ja enviado" e nao repete.

## Integracao com n8n (ja configurada)

O workflow **"WORKFLOW CREWOLADA"** no n8n tem 4 gatilhos (webhooks):

- `crewolada-whatsapp` — recebe a confirmacao de compra e envia o PDF do ingresso (WhatsApp + e-mail).
- `crewolada-admin-comando` — comando de broadcast enviado pelo WhatsApp do admin.
- `crewolada-broadcast-painel` — broadcast disparado pelo painel `/vendas`.
- `crewolada-lembrete` — lembretes agendados (texto simples, sem PDF) enviados pelo agendador do app.

## Configurando o webhook no Mercado Pago

No painel do Mercado Pago (Suas integracoes > sua aplicacao > Webhooks), cadastre:

```
https://SEU_BASE_URL/api/webhooks/mercadopago
```

com o evento **Pagamentos (legacy)**. Copie a "Chave secreta" gerada e coloque em `MP_WEBHOOK_SECRET`.

## Observacoes

- Os dados (pedidos, ingressos, templates de mensagem) sao persistidos em `data/db.json`. Em producao, monte um volume persistente nesse caminho (ex: EasyPanel > Armazenamento > Montagem de Volume em `/app/data`).
- As sessoes do validador e do painel de vendas ficam em memoria: reiniciar o servidor derruba o login (basta logar de novo).
- O scanner de QR code roda no navegador (camera do celular) via `html5-qrcode`, com fallback de digitacao manual do codigo.
- O CPF e validado (digito verificador) antes de seguir para o pagamento e e enviado ao Mercado Pago como identificacao do pagador.
