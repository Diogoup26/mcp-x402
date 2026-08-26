<p align="center">
  <img src="assets/mcp-x402-logo.png" alt="MCP x402 logo" width="160" />
</p>

# MCP x402 — Evidence-Backed Web Verification for AI Agents

[![AllMCPs Verified](https://allmcps.com/api/badge/mcp-x402-evidence-backed-web-verification)](https://allmcps.com/mcp/mcp-x402-evidence-backed-web-verification?verify=b470dbc0-c40c-43b7-b705-c3c789b04402)

## Verify a seller, product, offer, policy, or claim before an agent acts

Give an AI agent a public HTTP(S) page and 1 to 10 concrete conditions. The `verificar_condicoes` tool returns an evidence-based decision for every condition:

- `confirmado` — the page clearly supports the condition.
- `rejeitado` — the page clearly contradicts the condition.
- `incerto` — the available page evidence is insufficient.

Each verification includes the final source URL, page title, timestamp, condition-by-condition explanation, quoted evidence when available, a unique `verificationId`, and a SHA-256 `pageHash`.

### Designed for

- AI purchasing and procurement agents;
- seller, product and offer verification;
- pre-purchase due diligence;
- policy and terms checking;
- commercial automation that requires evidence before taking action.

### Simple x402 integration

- Free preflight validation before payment.
- `$0.05 USDC` per verification on Base mainnet.
- No account or subscription required.
- Available through MCP and HTTP.
- Ready-to-run buyer included in this repository.
- Bazaar discovery metadata enabled on the paid HTTP and MCP surfaces.

### Live endpoints

- MCP: `https://mcp-x402-production.up.railway.app/mcp`
- Free MCP preflight: `POST https://mcp-x402-production.up.railway.app/preflight/mcp`
- Free verification preflight: `POST https://mcp-x402-production.up.railway.app/preflight/verify-conditions`
- Paid verification: `POST https://mcp-x402-production.up.railway.app/verify-conditions`
- Health: `GET https://mcp-x402-production.up.railway.app/health`

The service also provides paid public URL analysis and general AI consultation through `analisar_url` and `consultar_ia`.

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
- Paid HTTP endpoints return valid x402 challenges with Bazaar metadata
- MCP and HTTP payment, execution, settlement, and delivery confirmed on-chain
- MCP Bazaar metadata advertises the public HTTPS MCP server URL
- CDP native MCP catalog indexing is not yet claimed as confirmed; upstream tracking: [coinbase/cdp-sdk#764](https://github.com/coinbase/cdp-sdk/issues/764)

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
| `PUBLIC_SERVICE_URL` | No | Canonical public HTTPS origin used in discovery metadata. Railway derives it automatically from `RAILWAY_PUBLIC_DOMAIN`; the production URL is the fallback. |
| `OBSERVABILITY_SALT` | Recommended | Stable secret salt used only to pseudonymize source/client fingerprints across restarts. |

### Local Buyer

| Variable | Required | Description |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | Yes | Private key of the Base mainnet buyer wallet. Never commit this value. |
| `JOURNEY_ID` | No | Existing correlation ID to reuse; otherwise the buyer generates one. |

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

## Railway Log Diagnostics

Railway currently accepts `--since` for historical HTTP logs but rejects
`--until`. On Windows PowerShell, export a bounded application and HTTP log
window without using the broken flag:

```powershell
.\scripts\export-railway-window.ps1 `
  -StartUtc "2026-08-22T16:31:22.401228537Z" `
  -EndUtc "2026-08-23T06:21:18.045229877Z" `
  -OutputPrefix "railway-diagnostic"
```

The script retrieves logs from the lower bound and applies the upper UTC bound
locally using ordinal ISO-8601 comparison, which preserves Railway's nanosecond
timestamps. It writes raw captures plus bounded `app` and `http` NDJSON files.

Analyze both bounded files while reading and validating every physical line:

```bash
npm run logs:analyze -- \
  --since "2026-08-22T16:31:22.401228537Z" \
  --pretty \
  --out railway-diagnostic-report.json \
  railway-diagnostic-app.ndjson railway-diagnostic-http.ndjson
```

The report includes per-file coverage, empty/valid/invalid line counts,
timestamp bounds, separation of `Diogo-*`, `RailwayHealthcheck`, known probes
or indexers and potentially external traffic, journey reconstruction and funnel
stopping points. It joins application `railwayRequestId` values to Railway HTTP
`requestId` values, understands HTTP `clientUa`, groups server-generated journey
IDs by fingerprint and temporal proximity, and counts only accepted normalized
feedback. It deliberately does not treat an isolated `402` as purchase intent
and does not infer human identity or motivation from request metadata.


## Ready-to-Run x402 Buyer

The repository includes ready-to-run buyers for applications and AI agents. The MCP buyer connects to the live service, validates the x402 payment requirements against Base mainnet USDC and a maximum payment of $0.05, signs the payment, retries the same tool call, and prints the settlement receipt and result.

Clone and prepare the buyer:

```bash
git clone https://github.com/Diogoup26/mcp-x402.git
cd mcp-x402
npm install
```

Create a local `.env.test` file in the project root:

```env
EVM_PRIVATE_KEY=0xYOUR_64_HEX_CHARACTER_PRIVATE_KEY
```

Never commit `.env.test` or expose the private key.

Build the project:

```bash
npm run build
```

The following commands authorize real x402 payments on Base mainnet:

- `consultar_ia`: $0.02 USDC
- `analisar_url`: $0.05 USDC
- `verificar_condicoes`: $0.05 USDC

### HTTP URL Analysis

```bash
npm run analyze -- "https://example.com" "Summarize this page."
```

### HTTP Decision Verification

```bash
npm run verify -- "https://example.com" "The page identifies the seller."
```

### MCP URL Analysis

```bash
npm run mcp:analyze -- "https://example.com" "Summarize this page."
```

### MCP AI Consultation

```bash
npm run mcp:consult -- "Reply only with: MCP OK"
```

### MCP Decision Verification

```bash
npm run mcp:verify -- "https://example.com" "The page identifies the seller."
```

A successful MCP payment prints:

- `PAGAMENTO MCP: success`
- the settlement receipt
- the tool response

The MCP buyer never prints the private key and rejects any payment that:

- is not on Base mainnet;
- does not use the configured Base USDC contract;
- exceeds $0.05 USDC.

## Machine-Readable Payment Continuation

The discovery document at `GET /.well-known/x402` and every successful free
preflight response publish a complete continuation sequence. A compatible
agent no longer has to infer what to do after the first unpaid request:

1. run the free preflight and keep its `x-journey-id`;
2. send the validated request without a payment signature;
3. read and verify the `payment-required` requirements;
4. authorize only the expected network, asset, amount and recipient;
5. retry the identical request with the x402 payment payload;
6. verify both delivery and the settlement receipt.

REST metadata recommends `@x402/fetch`; MCP metadata recommends `@x402/mcp`.
Paid responses also link back to the discovery instructions through
`x-payment-instructions`. The flow never requests a private key, Railway or
GitHub credentials, or an OpenAI key.

## Optional Conversion Feedback

Every paid HTTP or MCP response advertises `x-feedback-endpoint` and the
allowed normalized reason, stage, and intent values. The free preflight
responses include the same information in a `feedback` block. Feedback is
submitted to `POST /feedback`, contains no free text, and never includes a
private key, prompt, URL, page content, or payment payload.

The three buyers accept:

```text
--feedback-reason <research_only|no_wallet|unsupported_network|insufficient_funds|spending_not_authorized|price|insufficient_value|integration_error|other>
--feedback-stage <discovery|preflight|payment|execution|delivery>
--feedback-intent <research|analyze_page|verify_conditions|general_question|evaluate_service|other>
```

When `--feedback-reason` is supplied without `--feedback-stage`, the stage
defaults to `payment` and the buyer does not authorize a payment. The HTTP
buyers first receive the unsigned 402 challenge, submit the explicit feedback,
and stop. The MCP buyer stops after its free preflight and submits the explicit
feedback without requiring a wallet.

Example: report that the price stopped an evaluation, without paying:

```bash
npm run analyze -- "https://example.com" "Summarize this page." --feedback-reason price --feedback-intent evaluate_service
```

To submit explicit feedback after a completed delivery, select that stage:

```bash
npm run mcp:consult -- "Reply only with: MCP OK" --feedback-reason other --feedback-stage delivery --feedback-intent general_question
```

Buyers automatically submit only `integration_error`, and only for an
objectively detected technical failure such as failed discovery/preflight, an
HTTP 5xx result, a paid MCP tool error, or a missing settlement receipt after
a payment was made. They never infer `price`, `research_only`, `no_wallet`, or
another human or commercial motivation.

## Controlled Smoke Test (No Payment)

After deployment, validate discovery, preflight, the OpenAPI feedback contract,
normalized feedback submission, HTTP 402 challenges and feedback headers, HTTP
method handling, MCP initialization, tool discovery and the MCP x402 challenge:

```bash
npm run build
npm run smoke
```

Use `SERVICE_URL` to target another deployment. The test uses one persistent
`x-journey-id`, sends `User-Agent: Diogo-Smoke/1.2.7`, verifies that the MCP
x402 challenge advertises the public HTTPS endpoint with `type=mcp` and the
correct `toolName`, and never creates or
signs a payment.

The three payment buyers now perform discovery and a free preflight before the
paid request, using the same persistent journey ID throughout. Set `JOURNEY_ID`
to reuse an existing journey; otherwise each buyer creates and prints one.
The MCP buyer additionally requires the exact advertised price, Base USDC,
Base mainnet, and the configured service recipient before it can sign.

## Funnel Observability

The server emits structured events for MCP tool attempts, x402 challenges,
payment verification, execution, settlement and final tool outcome. It does
not log tool arguments or payment payloads. Settlement logs include the public
network and transaction identifier so completed purchases can be counted and
deduplicated.

Rejected MCP requests include safe protocol diagnostics such as method,
content type, `Accept`, JSON-RPC shape and the SDK error classification. All
events include the request and journey correlation fields when available.
Calls to a known paid tool that never reach its payment wrapper additionally
emit `mcp_pre_payment_rejection`, classified as invalid method, content type,
JSON-RPC envelope, arguments, transport/protocol rejection, or an otherwise
unreached handler. Argument values and payment payloads are never logged.
OpenAI usage events inherit the same request, journey, client, and source
correlation. Railway's `X-Railway-Request-Id`, edge POP, and request-start time
are also recorded, while client source fingerprints use Railway's stable
`X-Real-IP` value and remain pseudonymized with `OBSERVABILITY_SALT`.

## Deployment

The `main` branch is connected to Railway. Every successful push triggers a new deployment. Railway uses:

```bash
npm run build
npm start
```

The deployment health-check path is `/health`.

## License

ISC
