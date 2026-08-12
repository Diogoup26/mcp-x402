import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { createPaymentWrapper, type PaymentWrappedHandler } from "@x402/mcp";
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { load } from "cheerio";
import OpenAI from "openai";
import * as z from "zod/v4";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";
const MAX_DOWNLOAD_BYTES = 1_500_000;
const MAX_ANALYSIS_CHARS = 12_000;
const PAY_TO = process.env.X402_PAY_TO ?? "0xAe94Cc8080c9DcAF97Dda998F926ec52AF968d61";
const X402_NETWORK = (process.env.X402_NETWORK ?? "eip155:84532") as `${string}:${string}`;
const CONSULT_PRICE = "$0.02";
const ANALYZE_PRICE = "$0.05";
const X402_FACILITATOR_URL = "https://x402.org/facilitator";

const analyzeUrlInput = z.object({
  url: z.string().url().max(2048).describe("URL público HTTP ou HTTPS"),
  objetivo: z
    .string()
    .max(500)
    .optional()
    .describe("Objetivo opcional da análise"),
});

type AnalyzeUrlInput = z.infer<typeof analyzeUrlInput>;

type ExtractedPage = {
  finalUrl: string;
  title: string;
  text: string;
};

let openAIClient: OpenAI | undefined;

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY não foi encontrada no ambiente.");
  }

  openAIClient ??= new OpenAI({ apiKey, timeout: 120_000 });
  return openAIClient;
}

async function askOpenAI(
  prompt: string,
  operation: "consultar_ia" | "analisar_url",
  maxOutputTokens: number,
): Promise<string> {
  const response = await getOpenAIClient().responses.create({
    model: OPENAI_MODEL,
    max_output_tokens: maxOutputTokens,
    instructions:
      "Responde na mesma lingua da pergunta do utilizador, de forma clara, correta e concisa. Para perguntas gerais, usa o teu conhecimento para responder com rigor. Ao analisar conteudo fornecido, distingue factos desse conteudo de inferencias. Nao inventes fontes, links, dados recentes ou resultados de pesquisa. Se forem precisos dados atuais ou uma fonte especifica, explica essa limitacao. Nao reveles raciocinio interno.",
    input: prompt,
  });

    const usage = response.usage;
  const inputTokens = usage?.input_tokens ?? 0;
  const cachedInputTokens =
    usage?.input_tokens_details?.cached_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const reasoningTokens =
    usage?.output_tokens_details?.reasoning_tokens ?? 0;
  const uncachedInputTokens = Math.max(
    0,
    inputTokens - cachedInputTokens,
  );

  const estimatedOpenAiCostUsd =
    (uncachedInputTokens * 0.25 +
      cachedInputTokens * 0.025 +
      outputTokens * 2) /
    1_000_000;

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "openai_usage",
      operation,
      maxOutputTokens,
      model: OPENAI_MODEL,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens:
        usage?.total_tokens ?? inputTokens + outputTokens,
      estimatedOpenAiCostUsd: Number(
        estimatedOpenAiCostUsd.toFixed(8),
      ),
    }),
  );

  const answer = response.output_text.trim();

  if (!answer) {
    throw new Error("A OpenAI devolveu uma resposta vazia.");
  }

  return answer;
}

function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];

  if (mappedIpv4) {
    return isBlockedIp(mappedIpv4);
  }

  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      /^(fc|fd)/.test(normalized) ||
      /^fe[89ab]/.test(normalized)
    );
  }

  return true;
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Apenas URLs HTTP ou HTTPS são permitidos.");
  }

  if (url.username || url.password) {
    throw new Error("URLs com utilizador ou palavra-passe não são permitidos.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Endereços locais não são permitidos.");
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error("O endereço resolve para uma rede privada ou reservada.");
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error("A página excede o limite de 1,5 MB.");
  }

  if (!response.body) {
    throw new Error("A página não devolveu conteúdo.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error("A página excede o limite de 1,5 MB.");
    }
    result += decoder.decode(value, { stream: true });
  }

  return result + decoder.decode();
}

async function extractPage(inputUrl: string): Promise<ExtractedPage> {
  let currentUrl: URL;

  try {
    currentUrl = new URL(inputUrl);
  } catch {
    throw new Error("URL inválido.");
  }

  for (let redirect = 0; redirect <= 3; redirect += 1) {
    await assertPublicUrl(currentUrl);

    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "User-Agent": "DiogoMCP/1.0 (+URL analysis service)",
        Accept: "text/html,text/plain,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Redirecionamento sem destino.");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new Error(`A página respondeu com HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("O endereço não devolveu uma página de texto ou HTML.");
    }

    const html = await readLimitedText(response);
    const $ = load(html);
    $("script, style, noscript, svg, nav, footer, header, form").remove();

    const title = $("title").first().text().replace(/\s+/g, " ").trim();
    const preferred = $("main, article").first();
    const text = (preferred.length ? preferred : $("body"))
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ANALYSIS_CHARS);

    if (text.length < 80) {
      throw new Error("Não foi possível extrair texto suficiente da página.");
    }

    return { finalUrl: currentUrl.toString(), title, text };
  }

  throw new Error("A página excedeu o limite de três redirecionamentos.");
}

async function analyzePage({ url, objetivo }: AnalyzeUrlInput): Promise<{
  source: string;
  title: string;
  report: string;
}> {
  const page = await extractPage(url);
  const report = await askOpenAI(`
Analisa o conteúdo abaixo sem usar conhecimentos externos.

URL final: ${page.finalUrl}
Título: ${page.title || "Sem título"}
Objetivo: ${objetivo || "Análise geral"}

Devolve exatamente estas secções:
1. Resumo
2. Factos principais
3. Riscos ou limitações
4. Ações recomendadas

Se uma informação não estiver no conteúdo, declara que não foi encontrada.

CONTEÚDO DA PÁGINA:
${page.text}
`,
    "analisar_url",
    4_000,
  );

  return {
    source: page.finalUrl,
    title: page.title || "Sem título",
    report,
  };
}

const facilitatorClient = createCdpFacilitatorClient();
const paymentServer = new x402ResourceServer(facilitatorClient).register(
  X402_NETWORK,
  new ExactEvmScheme(),
);

await paymentServer.initialize();

const paidConsultRequirements =
  await paymentServer.buildPaymentRequirements({
    scheme: "exact",
    price: CONSULT_PRICE,
    network: X402_NETWORK,
    payTo: PAY_TO,
  });

const paidAnalyzeRequirements =
  await paymentServer.buildPaymentRequirements({
    scheme: "exact",
    price: ANALYZE_PRICE,
    network: X402_NETWORK,
    payTo: PAY_TO,
  });

const paidConsultTool = createPaymentWrapper(paymentServer, {
  accepts: paidConsultRequirements,
  resource: {
    url: "mcp://tool/consultar_ia",
    description: "Consulta paga à OpenAI.",
    serviceName: "Diogo AI Service",
    tags: ["ai", "openai"],
  },
  extensions: declareDiscoveryExtension({
    toolName: 'consultar_ia',
    description: 'Ask the OpenAI model a question and receive a concise answer.',
    transport: 'streamable-http',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Question or instruction for the AI.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  }),
});

const paidAnalyzeUrlTool = createPaymentWrapper(paymentServer, {
  accepts: paidAnalyzeRequirements,
  resource: {
    url: "mcp://tool/analisar_url",
    description: "Análise paga de uma página web pública.",
    serviceName: "Diogo AI Service",
    tags: ["ai", "url-analysis", "research"],
  },
  extensions: declareDiscoveryExtension({
    toolName: 'analisar_url',
    description: 'Analyze a public web page and return a report with summary, facts, risks and recommended actions.',
    transport: 'streamable-http',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Public HTTP or HTTPS URL to analyze.' },
        objetivo: { type: 'string', description: 'Optional analysis objective.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  }),
});

function adaptPaymentWrapperForMcpV2(
  wrapper: ReturnType<typeof createPaymentWrapper>,
) {
  return <TArgs extends Record<string, unknown>>(
    handler: PaymentWrappedHandler<TArgs>,
  ) => {
    const callback = wrapper(handler);

    return (args: TArgs, context: ServerContext) =>
      callback(args, {
        ...context,
        _meta: context.mcpReq._meta,
      });
  };
}

const paidConsultToolV2 =
  adaptPaymentWrapperForMcpV2(paidConsultTool);
const paidAnalyzeUrlToolV2 =
  adaptPaymentWrapperForMcpV2(paidAnalyzeUrlTool);

const handler = createMcpHandler(() => {
  const server = new McpServer({
    name: "diogo-ai-service",
    version: "1.2.0",
  });

  server.registerTool(
    "consultar_ia",
    {
      title: "Consultar IA",
      description: "Envia uma pergunta para a OpenAI e devolve a resposta.",
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000).describe("Pergunta ou instrução para a IA"),
      }),
    },
    paidConsultToolV2(async ({ prompt }) => {
      try {
        const answer = await askOpenAI(prompt, "consultar_ia", 2_000);
        return { content: [{ type: "text", text: answer }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro desconhecido";
        return {
          isError: true,
          content: [{ type: "text", text: `Falha ao consultar a IA: ${message}` }],
        };
      }
    }),
  );

  server.registerTool(
    "analisar_url",
    {
      title: "Analisar página web",
      description:
        "Extrai uma página web pública e produz um relatório com resumo, factos, riscos e ações recomendadas.",
      inputSchema: analyzeUrlInput,
    },
    paidAnalyzeUrlToolV2(async ({ url, objetivo }) => {
      try {
        const analysis = await analyzePage({ url, objetivo });

        return {
          content: [
            {
              type: "text",
              text: `Fonte: ${analysis.source}\nTítulo: ${analysis.title}\n\n${analysis.report}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro desconhecido";
        return {
          isError: true,
          content: [{ type: "text", text: `Falha ao analisar o URL: ${message}` }],
        };
      }
    }),
  );

  return server;
});

const app = createMcpExpressApp({ host: HOST, allowedHosts: ['localhost', '127.0.0.1', 'healthcheck.railway.app', process.env.RAILWAY_PUBLIC_DOMAIN ?? 'mcp-x402-production.up.railway.app'] });
app.set('trust proxy', 1);
app.use(helmet());
app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = randomUUID();
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'http_request',
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
});
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests. Try again later." } }));
const nodeHandler = toNodeHandler(handler);
const requireAnalyzePayment = paymentMiddleware(
  {
    "POST /analyze": {
      accepts: {
        scheme: "exact",
        price: ANALYZE_PRICE,
        network: X402_NETWORK,
        payTo: PAY_TO,
      },
      description:
        "Analisa uma página web pública e devolve resumo, factos, riscos e ações recomendadas.",
      mimeType: "application/json",
      serviceName: "Diogo AI URL Analysis",
      tags: ["ai", "url-analysis", "research"],
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: 'json',
          input: {
            url: 'https://example.com',
            objetivo: 'Summarize this page.',
          },
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri', description: 'Public HTTP or HTTPS URL to analyze.' },
              objetivo: { type: 'string', description: 'Optional analysis objective.' },
            },
            required: ['url'],
            additionalProperties: false,
          },
          output: {
            example: {
              source: 'https://example.com/',
              title: 'Example Domain',
              report: 'Summary, facts, risks and recommended actions.',
            },
          },
        }),
      },
    },
  },
  paymentServer,
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: "openai",
    model: OPENAI_MODEL,
    tools: ["consultar_ia", "analisar_url"],
    paidEndpoint: {
      method: "POST",
      path: "/analyze",
      price: ANALYZE_PRICE,
      network: X402_NETWORK,
    },
    paidMcpTools: [
      { name: "consultar_ia", price: CONSULT_PRICE, network: X402_NETWORK },
      { name: "analisar_url", price: ANALYZE_PRICE, network: X402_NETWORK },
    ],
  });
});

app.all("/mcp", (req, res) => {
  void nodeHandler(req, res, req.body);
});

app.post(
  "/analyze",
  (req, res, next) => {
    const parsed = analyzeUrlInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Pedido inválido.",
        details: z.treeifyError(parsed.error),
      });
      return;
    }

    res.locals.analyzeInput = parsed.data;
    next();
  },
  requireAnalyzePayment,
  async (_req, res) => {
    try {
      const input = res.locals.analyzeInput as AnalyzeUrlInput;
      const analysis = await analyzePage(input);
      res.json(analysis);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      res.status(502).json({ error: `Falha ao analisar o URL: ${message}` });
    }
  },
);

app.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`MCP ativo em http://${displayHost}:${PORT}/mcp`);
  console.log(`Health endpoint: http://${displayHost}:${PORT}/health`);
  console.log(
    `Analysis x402 endpoint: http://${displayHost}:${PORT}/analyze (${ANALYZE_PRICE}, Base mainnet)`,
  );
});
