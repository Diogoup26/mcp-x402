# MCP x402 - Paid AI URL Analysis

A production-ready Model Context Protocol (MCP) service and HTTP API that provides paid AI assistance and public URL analysis using the OpenAI Responses API and x402 payments.

## Live Service

- Base URL: `https://mcp-x402-production.up.railway.app`
- Health check: `GET /health`
- MCP endpoint: `POST /mcp`
- Paid URL analysis: `POST /analyze`
- Price: `$0.01 USDC` per paid request
- Network: Base Sepolia (`eip155:84532`)

## MCP Tools

| Tool | Description | Price |
| --- | --- | --- |
| `consultar_ia` | Sends a prompt to the OpenAI Responses API. | $0.01 USDC |
| `analisar_url` | Fetches and analyzes a public HTTP or HTTPS page. | $0.01 USDC |

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
| `EVM_PRIVATE_KEY` | Yes | Private key of the Base Sepolia buyer wallet. Never commit this value. |

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

Each command below authorizes an x402 payment of 0.01 USDC on Base Sepolia. Only run one when a paid test is intended.

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
