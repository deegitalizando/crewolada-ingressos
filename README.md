# Crewolada - Ingressos

Sistema de venda de ingressos por lotes, com QR code, PDF do ingresso, checkout via Mercado Pago e validador de entrada.

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
| `MP_ACCESS_TOKEN` | Access token do Mercado Pago (Checkout Pro). Use um token `TEST-...` para testar em sandbox. |
| `MP_WEBHOOK_SECRET` | Chave secreta do webhook (Mercado Pago > Suas integracoes > Webhooks). Opcional, mas recomendado em producao. |
| `N8N_WEBHOOK_URL` | URL do Webhook node do seu workflow n8n. |
| `VALIDATOR_PASSWORD` | Senha de acesso do validador (`/validador`). |
| `DEFAULT_COUNTRY_CODE` | DDI usado para normalizar o telefone (Brasil = `55`). |

Os **lotes** (quantidade e preco de cada faixa) nao ficam no `.env` — sao definidos em [src/lotes.js](src/lotes.js), porque o preco muda sozinho conforme os ingressos vao sendo vendidos:

```js
const LOTES = [
  { name: '1o Lote', quantity: 50, price: 15.0 },
  { name: '2o Lote', quantity: 150, price: 20.0 },
  { name: '3o Lote', quantity: 800, price: 25.0 },
];
```

Para mudar quantidades/precos, edite esse arquivo e reimplante o app.

## Fluxo

1. Comprador acessa `/`, ve o preco do lote atual e escolhe a quantidade (+/-). Ao clicar em "Garantir meu ingresso" vai para `/checkout/dados`.
2. Em `/checkout/dados` preenche nome e WhatsApp, e paga direto na pagina (cartao, Pix ou boleto) usando o **Payment Brick** do Mercado Pago — o comprador nunca sai do site. O Brick coleta e-mail e CPF como parte do proprio formulario de pagamento.
3. O pagamento e criado via `POST /api/pagamentos`. Se aprovado na hora (cartao), os ingressos ja saem gerados. Se ficar pendente (Pix/boleto), o Mercado Pago chama `POST /api/webhooks/mercadopago` quando o status mudar.
4. Quando o pagamento e aprovado, o sistema gera 1 ingresso (com QR code + PDF) por unidade comprada e envia um `POST` para `N8N_WEBHOOK_URL` por ingresso.
5. O comprador acompanha em `/pedido/:id` (atualiza sozinho): mostra o QR Code do Pix se for o caso, ou os links dos ingressos quando aprovado. Cada ingresso tambem pode ser visto em `/ingresso/:codigo`, com botoes para imprimir ou compartilhar o PDF.
6. Na entrada do evento, a equipe acessa `/validador`, entra com `VALIDATOR_PASSWORD` e escaneia o QR code (ou digita o codigo manualmente). Cada ingresso so pode ser validado uma vez.

## Integracao com n8n (ja configurada)

O envio do ingresso usa o workflow **"WORKFLOW CREWOLADA"** que ja existe no n8n:

`Receber Ingresso Aprovado` (webhook) -> `Preparar Anexo PDF` (converte o PDF em anexo) -> em paralelo: `Enviar Ingresso via WhatsApp` (Evolution API, documento PDF) e `Enviar Ingresso por Email` (Gmail).

Este app faz **um POST por ingresso** para `N8N_WEBHOOK_URL` com este formato:

```json
{
  "nome": "Fulano da Silva",
  "email": "fulano@email.com",
  "nomeLote": "1o Lote",
  "codigo": "CRW-AB12CD34EF",
  "whatsapp": "5521999999999",
  "pdfBase64": "JVBERi0xLjMK...",
  "fileName": "ingresso-CRW-AB12CD34EF.pdf"
}
```

Se um pedido tiver 3 ingressos, sao feitas 3 chamadas (uma por pessoa/PDF). Ambas as mensagens (WhatsApp e e-mail) trazem o texto "aqui esta seu ingresso" com as orientacoes de uso.

O mesmo workflow tambem tem um recurso de broadcast: mandando uma mensagem do numero admin configurado (`5521981565209`) com o texto `enviar a seguinte mensagem para todos os contatos: <mensagem>`, ele reenvia (com variacoes via IA, para evitar bloqueio) para todos os contatos da instancia Evolution API.

## Configurando o webhook no Mercado Pago

No painel do Mercado Pago (Suas integracoes > sua aplicacao > Webhooks), cadastre:

```
https://SEU_BASE_URL/api/webhooks/mercadopago
```

com o evento **Pagamentos**. Copie a "Chave secreta" gerada e coloque em `MP_WEBHOOK_SECRET`.

## Observacoes

- Os dados (pedidos e ingressos) sao persistidos em `data/db.json`. Em producao, monte um volume persistente nesse caminho (ex: EasyPanel > Armazenamento > Montagem de Volume em `/app/data`).
- As sessoes do validador ficam em memoria: reiniciar o servidor derruba o login da equipe (basta logar de novo).
- O scanner de QR code roda no navegador (camera do celular) via `html5-qrcode`, com fallback de digitacao manual do codigo.
- O CPF e validado (digito verificador) antes de seguir para o pagamento e e enviado ao Mercado Pago como identificacao do pagador.
