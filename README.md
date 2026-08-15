# MCP x402 - Paid AI Verification and URL Analysis
## Pay-per-use AI analysis for agents and applications

Send a public HTTP or HTTPS URL and receive a concise report with a summary, key facts, risks or limitations, and recommended actions.

- **No account or subscription:** payment is made per request with x402.
- **Transparent prices:** $0.02 for `consultar_ia`; $0.05 for `analisar_url` and `verificar_condicoes` on Base mainnet.
- **Agent-ready:** available through MCP as `consultar_ia`, `analisar_url`, and `verificar_condicoes`.
- **Live and validated:** x402 v2, Coinbase validation passed, and Bazaar discovery metadata enabled.
- **Live endpoint:** `https://mcp-x402-production.up.railway.app/analyze`
- **Service status:** `https://mcp-x402-production.up.railway.app/health`
- **Integration help:** open an issue at `https://github.com/Diogoup26/mcp-x402/issues`.

Ideal for AI agents, research automations, content screening, and applications that need webpage analysis without managing their own OpenAI integration.

A production-ready Model Context Protocol (MCP) service and HTTP API that provides paid AI assistance and public URL analysis using the OpenAI Responses API and x402 payments.

## Live Service

- Base URL: `https://mcp-x402-production.up.railway.app`
- Health check: `GET /health`
- MCP endpoint: `POST /mcp`
- Paid URL analysis: `POST /analyze`
- Price: `$0.05 USDC` per paid request
- Network: Base mainnet (`eip155:8453`)

## Production Status

- Production deployment active on Railway
- x402 version 2 payment flow
- Base mainnet payments (`eip155:8453`)
- Coinbase x402 validation passed
- Simulation accepted with HTTP 402
- Bazaar discovery metadata enabled
- Coinbase index active

## MCP Tools

## Decision verification

### `verificar_condicoes` — $0.05 USDC

A paid decision-verification tool for agents.

Give it a public URL and one or more concrete conditions. It returns a decision based only on evidence extracted from that page:

- `confirmado` — the page clearly proves the condition.
- `rejeitado` — the page clearly contradicts the condition.
- `incerto` — the page does not provide enough evidence.

Each result includes the final source URL, page title, verification timestamp, condition-by-condition explanation, and a short quoted proof where available.

Example conditions:

- “The page identifies the seller.”
- “The product is available in Portugal.”
- “The page shows a price in euros.”
- “The document states that the service supports x402.”

This is designed for agents that need an evidence-based decision before taking the next action.

| Tool | Description | Price |
| --- | --- | --- |
| `consultar_ia` | Sends a prompt to the OpenAI Responses API. | $0.02 USDC |
| `analisar_url` | Fetches and analyzes a public HTTP or HTTPS page. | $0.05 USDC |
| `verificar_condicoes` | Verifies concrete conditions on a public page and returns evidence-based decisions. | $0.05 USDC |

## Technology

- Node.js and TypeScript
- Express
- Model Context Protocol
- OpenAI Responses API
- x402 payments
- viem
- Cheerio
- Railway

## Security

- HTTPS provided by Railway
- Helmet security headers
- Rate limit of 100 requests per 15 minutes
- Structured request logs with unique request IDs
- Host validation and Railway health-check support
- Restricted OpenAI API key with access only to `/v1/responses`
- Environment files and secrets excluded from Git

## Environment Variables

### Server

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | OpenAI project API key. |
| `OPENAI_MODEL` | No | OpenAI model. Defaults to `gpt-5-mini`. |
| `HOST` | No | Listening host. Defaults to `0.0.0.0`. |
| `PORT` | No | Listening port. Defaults to `3000`. |
| `RAILWAY_PUBLIC_DOMAIN` | Railway | Automatically supplied by Railway. |

### Local Buyer

| Variable | Required | Description |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | Yes | Private key of the Base mainnet buyer wallet. Never commit this value. |

Example local `.env.test` file:

```env
EVM_PRIVATE_KEY=your_private_key_here
```

## Local Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Build the project:

```bash
npm run build
```

Start the compiled server:

```bash
npm start
```

## Health Check

The health endpoint is public and does not require payment:

```bash
curl https://mcp-x402-production.up.railway.app/health
```


## Paid End-to-End Tests

Build the project before running a buyer:

```bash
npm run build
```

The commands below authorize real x402 payments on Base mainnet: 0.02 USDC for `consultar_ia` and 0.05 USDC for `analisar_url`. Only run a command when a real paid request is intended.

### HTTP URL Analysis

```bash
npm run analyze -- "https://example.com" "Summarize this page."
```

### MCP URL Analysis

```bash
npm run mcp:analyze -- "https://example.com" "Summarize this page."
```

### MCP AI Consultation

```bash
npm run mcp:consult -- "Reply only with: MCP OK"
```

A successful MCP payment prints `PAGAMENTO MCP: success`, a settlement receipt, and the tool response.

## Deployment

The `main` branch is connected to Railway. Every successful push triggers a new deployment. Railway uses:

```bash
npm run build
npm start
```

The deployment health-check path is `/health`.

## License

ISC
