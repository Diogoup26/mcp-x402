import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
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
const VERIFY_PRICE = "$0.05";
const X402_FACILITATOR_URL = "https://x402.org/facilitator";

const analyzeUrlInput = z.object({
  url: z.string().url().max(2048).describe("URL público HTTP ou HTTPS"),
  objetivo: z
    .string()
    .max(500)
    .optional()
    .describe("Objetivo opcional da análise"),
});

const verifyConditionsInput = z.object({
  url: z.string().url().max(2048).describe("URL público HTTP ou HTTPS"),
  condicoes: z
    .array(z.string().trim().min(3).max(300))
    .min(1)
    .max(10)
    .describe("Condições concretas que a página tem de cumprir"),
  contexto: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe("Contexto opcional para interpretar as condições"),
});

type VerifyConditionsInput = z.infer<typeof verifyConditionsInput>;

const verificationDecisionSchema = z.object({
  decisao: z.enum(["confirmado", "rejeitado", "incerto"]),
  condicoes: z.array(
    z.object({
      condicao: z.string(),
      estado: z.enum(["confirmada", "rejeitada", "incerta"]),
      prova: z.string().nullable(),
      explicacao: z.string(),
    }),
  ),
  resumo: z.string(),
});

type VerificationDecision = z.infer<typeof verificationDecisionSchema>;


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
  operation: "consultar_ia" | "analisar_url" | "verificar_condicoes",
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

async function verifyConditions({
  url,
  condicoes,
  contexto,
}: VerifyConditionsInput): Promise<{
  source: string;
  title: string;
  verifiedAt: string;
  decisao: VerificationDecision;
  verificationId: string;
  pageHash: string;
}> {
  const page = await extractPage(url);
  const verificationId = randomUUID();
  const pageHash = `sha256:${createHash("sha256").update(page.text, "utf8").digest("hex")}`;
  const listaCondicoes = condicoes
    .map((condicao, index) => `${index + 1}. ${condicao}`)
    .join("\n");

  const raw = await askOpenAI(
    `Verifica se uma página web cumpre condições concretas.

URL final: ${page.finalUrl}
Título: ${page.title || "Sem título"}
${contexto ? `Contexto: ${contexto}` : ""}

CONDIÇÕES A VERIFICAR:
${listaCondicoes}

Responde SOMENTE com JSON válido, sem markdown, neste formato:
{
  "decisao": "confirmado | rejeitado | incerto",
  "condicoes": [
    {
      "condicao": "texto da condição",
      "estado": "confirmada | rejeitada | incerta",
      "prova": "citação curta e exata da página, ou null",
      "explicacao": "explicação curta baseada apenas na página"
    }
  ],
  "resumo": "conclusão curta"
}

REGRAS:
- Usa exclusivamente o conteúdo da página fornecido abaixo.
- Nunca inventes preço, stock, entrega, composição, identidade do vendedor ou qualquer outro facto.
- Usa "confirmada" apenas quando a página provar claramente a condição.
- Usa "rejeitada" apenas quando a página contradisser claramente a condição.
- Se faltar prova suficiente, usa "incerta" e "prova": null.
- Devolve uma entrada por cada condição recebida.

CONTEÚDO DA PÁGINA:
${page.text}`,
    "verificar_condicoes",
    1_800,
  );

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error("A IA não devolveu uma verificação em JSON válido.");
  }

  const parsedDecision = verificationDecisionSchema.safeParse(parsedJson);
  if (!parsedDecision.success) {
    throw new Error("A IA devolveu uma verificação num formato inválido.");
  }

  if (parsedDecision.data.condicoes.length !== condicoes.length) {
    throw new Error("A IA não respondeu a todas as condições pedidas.");
  }

  return {
    source: page.finalUrl,
    title: page.title || "Sem título",
    verifiedAt: new Date().toISOString(),
    decisao: parsedDecision.data,
    verificationId,
    pageHash,
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

  const paidVerifyRequirements =
  await paymentServer.buildPaymentRequirements({
    scheme: "exact",
    price: VERIFY_PRICE,
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

const paidVerifyConditionsTool = createPaymentWrapper(paymentServer, {
  accepts: paidVerifyRequirements,
  resource: {
    url: "mcp://tool/verificar_condicoes",
    description:
      "Verifica se uma página pública cumpre condições concretas e devolve decisão com provas.",
    serviceName: "Diogo AI Service",
    tags: ["ai", "verification", "web"],
  },
  extensions: declareDiscoveryExtension({
    toolName: "verificar_condicoes",
    description:
      "Verify whether a public web page meets concrete conditions. Returns confirmed, rejected or uncertain with quoted evidence.",
    transport: "streamable-http",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "Public HTTP or HTTPS URL to verify.",
        },
        condicoes: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          description: "Concrete conditions to verify.",
        },
        contexto: {
          type: "string",
          description: "Optional context for interpreting the conditions.",
        },
      },
      required: ["url", "condicoes"],
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

const paidVerifyConditionsToolV2 =
  adaptPaymentWrapperForMcpV2(paidVerifyConditionsTool);

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

    server.registerTool(
    "verificar_condicoes",
    {
      title: "Verificar condições",
      description:
        "Verifica se uma página web pública cumpre condições concretas e devolve decisão confirmada, rejeitada ou incerta com provas textuais.",
      inputSchema: verifyConditionsInput,
    },
    paidVerifyConditionsToolV2(async ({ url, condicoes, contexto }) => {
      try {
        const verification = await verifyConditions({
          url,
          condicoes,
          contexto,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(verification, null, 2),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro desconhecido";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Falha ao verificar as condições: ${message}`,
            },
          ],
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

const requireVerifyConditionsPayment = paymentMiddleware(
  {
    "POST /verify-conditions": {
      accepts: {
        scheme: "exact",
        price: VERIFY_PRICE,
        network: X402_NETWORK,
        payTo: PAY_TO,
      },
      description:
        "Verifica se uma página web pública cumpre condições concretas e devolve uma decisão com evidência.",
      mimeType: "application/json",
      serviceName: "Diogo AI Condition Verification",
      tags: ["ai", "verification", "evidence", "web"],
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          input: {
            url: "https://example.com",
            condicoes: ["The page identifies the seller."],
          },
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                format: "uri",
                description: "Public HTTP or HTTPS URL to verify.",
              },
              condicoes: {
                type: "array",
                items: {
                  type: "string",
                },
                minItems: 1,
                maxItems: 10,
                description:
                  "Concrete conditions that the page must satisfy.",
              },
              contexto: {
                type: "string",
                description:
                  "Optional context for interpreting the conditions.",
              },
            },
            required: ["url", "condicoes"],
            additionalProperties: false,
          },
          output: {
            example: {
              source: "https://example.com/",
              title: "Example Domain",
              verifiedAt: "2026-08-15T00:00:00.000Z",
              decisao: {
                decisao: "confirmado",
                condicoes: [
                  {
                    condicao: "The page identifies the seller.",
                    estado: "confirmada",
                    prova: "Example Domain",
                    explicacao:
                      "The page explicitly identifies the seller.",
                  },
                ],
                resumo:
                  "Condition confirmed based on extracted page content.",
              },
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
    tools: ["consultar_ia", "analisar_url", "verificar_condicoes"],
    paidEndpoint: {
      method: "POST",
      path: "/analyze",
      price: ANALYZE_PRICE,
      network: X402_NETWORK,
    },
    paidMcpTools: [
      { name: "consultar_ia", price: CONSULT_PRICE, network: X402_NETWORK },
      { name: "analisar_url", price: ANALYZE_PRICE, network: X402_NETWORK },
      { name: "verificar_condicoes", price: VERIFY_PRICE, network: X402_NETWORK },
    ],
  });
});

const PUBLIC_SERVICE_URL = "https://mcp-x402-production.up.railway.app";

app.get("/.well-known/x402", (_req, res) => {
  res.json({
    x402Version: 2,
    service: {
      name: "Diogo AI URL Analysis",
      description:
        "Análise paga de páginas web públicas com resumo, factos, riscos e ações recomendadas.",
      url: PUBLIC_SERVICE_URL,
    },
    endpoints: [
      {
        path: "/analyze",
        method: "POST",
        price: ANALYZE_PRICE,
        network: X402_NETWORK,
        paymentHeader: "payment-required",
        description: "Analisa uma página web pública.",
      },
      {
        path: "/verify-conditions",
        method: "POST",
        price: VERIFY_PRICE,
        network: X402_NETWORK,
        paymentHeader: "payment-required",
        description:
          "Verifica condições numa página web pública e devolve um recibo auditável: decisão por condição, provas, ID único e hash SHA-256 do conteúdo.",
      },  
        {
        path: "/mcp",
        method: "POST",
        protocol: "Model Context Protocol",
        description: "Ferramentas MCP pagas para consulta de IA e análise de URLs.",
      },
    ],
  });
});

app.get("/openapi.json", (_req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "Diogo AI URL Analysis",
      version: "1.2.0",
      description:
        "Serviço x402 para analisar páginas web públicas com IA. O pagamento é exigido através do cabeçalho payment-required.",
    },
    servers: [{ url: PUBLIC_SERVICE_URL }],
    paths: {
      "/analyze": {
        post: {
          summary: "Analisa uma página web pública",
          tags: ["URL analysis", "x402"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: {
                    url: {
                      type: "string",
                      format: "uri",
                      description: "URL pública HTTP ou HTTPS a analisar.",
                    },
                    objetivo: {
                      type: "string",
                      description: "Objetivo opcional da análise.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Análise concluída." },
            "400": { description: "Pedido inválido." },
            "402": {
              description: "Pagamento x402 necessário.",
              headers: {
                "payment-required": {
                  description: "Condições de pagamento x402.",
                  schema: { type: "string" },
                },
              },
            },
            "502": { description: "Falha temporária ao analisar a URL." },
          },
        },
      },
            "/verify-conditions": {
        post: {
          summary: "Verifica condições numa página web",
          description:
            "Devolve um recibo auditável com decisão por condição, prova textual, data/hora, ID único e hash SHA-256 do conteúdo.",
          tags: ["Decision verification", "x402"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url", "condicoes"],
                  properties: {
                    url: {
                      type: "string",
                      format: "uri",
                      description: "URL pública HTTP ou HTTPS a verificar.",
                    },
                    condicoes: {
                      type: "array",
                      minItems: 1,
                      maxItems: 10,
                      items: { type: "string" },
                      description:
                        "Condições concretas que a página deve cumprir.",
                    },
                    contexto: {
                      type: "string",
                      description:
                        "Contexto opcional para interpretar as condições.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Recibo auditável: decisão por condição, prova textual quando disponível, verificationId e pageHash SHA-256.",
            },
            "400": { description: "Pedido inválido." },
            "402": {
              description: "Pagamento x402 necessário.",
              headers: {
                "payment-required": {
                  description: "Condições de pagamento x402.",
                  schema: { type: "string" },
                },
              },
            },
            "502": { description: "Falha temporária ao verificar a página." },
          },
        },
      },
      "/mcp": {
        post: {
          summary: "Endpoint Model Context Protocol",
          tags: ["MCP"],
          responses: {
            "200": { description: "Resposta MCP." },
          },
        },
      },
    },
  });
});

app.get("/agents.json", (_req, res) => {
  res.json({
    name: "Diogo AI URL Analysis",
    version: "1.2.0",
    description:
      "Serviço MCP/x402 para análise de URLs públicas, consulta de IA e verificação auditável de condições.",
    endpoints: {
      mcp: `${PUBLIC_SERVICE_URL}/mcp`,
      verifyConditions: `${PUBLIC_SERVICE_URL}/verify-conditions`,
      analyze: `${PUBLIC_SERVICE_URL}/analyze`,
      health: `${PUBLIC_SERVICE_URL}/health`,
    },
    payment: {
      protocol: "x402",
      network: X402_NETWORK,
      currency: "USDC",
      verifyPrice: VERIFY_PRICE,
      analyzePrice: ANALYZE_PRICE,
      consultPrice: CONSULT_PRICE,
    },
    capabilities: [
      "Analisar uma URL pública",
      "Resumir e extrair factos",
      "Identificar riscos e ações recomendadas",
      "Verificar condições com recibo auditável, decisão e prova textual",
      "Consultar IA",
    ],
  });
});

app.get("/llms.txt", (_req, res) => {
  res.type("text/plain; charset=utf-8").send(
    `# Diogo AI URL Analysis

> Serviço MCP e x402 para analisar páginas web públicas e verificar condições com recibos auditáveis.

## Endpoints

- MCP: ${PUBLIC_SERVICE_URL}/mcp
- Análise paga: POST ${PUBLIC_SERVICE_URL}/analyze
- Verificação paga: POST ${PUBLIC_SERVICE_URL}/verify-conditions — decisão por condição, provas, verificationId e pageHash SHA-256
- Estado: GET ${PUBLIC_SERVICE_URL}/health
- Especificação OpenAPI: GET ${PUBLIC_SERVICE_URL}/openapi.json

## Pagamento

Os endpoints /analyze e /verify-conditions requerem pagamento x402 em USDC na rede ${X402_NETWORK}.
Após receber HTTP 402, lê o cabeçalho payment-required, efetua o pagamento e repete o mesmo pedido.

## Pedido de exemplo

POST ${PUBLIC_SERVICE_URL}/analyze
Content-Type: application/json

{"url":"https://example.com","objetivo":"Resumir factos, riscos e ações recomendadas."}
`
  );
});

app.all("/mcp", (req, res) => {
  const body = req.body as unknown;
  const bodyKind =
    body === null ? "null" :
    Array.isArray(body) ? "array" :
    typeof body;

  const jsonRpcMethod =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "method" in body &&
    typeof (body as { method?: unknown }).method === "string"
      ? (body as { method: string }).method
      : null;

  res.on("finish", () => {
    if (res.statusCode < 400) return;

    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "mcp_rejection",
      requestId: res.getHeader("x-request-id") ?? null,
      status: res.statusCode,
      contentType: req.get("content-type") ?? null,
      mcpProtocolVersion: req.get("mcp-protocol-version") ?? null,
      bodyKind,
      jsonRpcMethod,
    }));
  });

  void nodeHandler(req, res, req.body);
});

app.post(
  "/analyze",
  (req, res, next) => {
    if (req.get("payment-signature")) {
      next();
      return;
    }

    void requireAnalyzePayment(req, res, next);
  },
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

app.post(
  "/verify-conditions",
  (req, res, next) => {
    if (req.get("payment-signature")) {
      next();
      return;
    }

    void requireVerifyConditionsPayment(req, res, next);
  },
  (req, res, next) => {
    const parsed = verifyConditionsInput.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Pedido inválido.",
        details: z.treeifyError(parsed.error),
      });
      return;
    }

    res.locals.verifyConditionsInput = parsed.data;
    next();
  },
  requireVerifyConditionsPayment,
  async (_req, res) => {
    try {
      const input =
        res.locals.verifyConditionsInput as VerifyConditionsInput;
      const verification = await verifyConditions(input);
      res.json(verification);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro desconhecido";
      res
        .status(502)
        .json({
          error: `Falha ao verificar as condições: ${message}`,
        });
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
