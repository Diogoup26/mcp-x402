import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import {
  createPaymentWrapper,
  type PaymentWrappedHandler,
  type PaymentWrapperConfig,
} from "@x402/mcp";
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { load } from "cheerio";
import OpenAI from "openai";
import * as z from "zod/v4";
import helmet from "helmet";
import type { ErrorRequestHandler } from "express";
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
const SERVICE_VERSION = "1.2.2";
const X402_FACILITATOR_URL = "https://x402.org/facilitator";
const DISCOVERY_PATHS = new Set([
  "/",
  "/.well-known/x402.json",
  "/robots.txt",
  "/.well-known/x402",
  "/openapi.json",
  "/agents.json",
  "/llms.txt",
]);

const PREFLIGHT_PATHS = new Set([
  "/preflight/analyze",
  "/preflight/verify-conditions",
]);

const JOURNEY_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const OBSERVABILITY_SALT =
  process.env.OBSERVABILITY_SALT?.trim() || randomUUID();
const FEEDBACK_REASONS = [
  "research_only",
  "no_wallet",
  "unsupported_network",
  "insufficient_funds",
  "spending_not_authorized",
  "price",
  "insufficient_value",
  "integration_error",
  "other",
] as const;

type McpTraceState = {
  jsonRpcMethod: string | null;
  toolName: string | null;
  paymentPayloadPresent: boolean | null;
  paymentVerified: boolean;
  challengeIssued: boolean;
  paymentErrorCategory: string | null;
  executionStartedAt: number | null;
  executionFinishedAt: number | null;
  executionSucceeded: boolean | null;
  settlementAttempted: boolean;
  settlementSucceeded: boolean | null;
  settlementNetwork: string | null;
  settlementTransaction: string | null;
  handlerErrorCode: string | number | null;
  handlerErrorMessage: string | null;
};

type McpRequestTrace = {
  requestId: string;
  journeyId: string;
  journeyIdSource: "client" | "server";
  sourceFingerprint: string;
  clientFingerprint: string;
  userAgent: string | null;
  state: McpTraceState;
};

const mcpRequestContext = new AsyncLocalStorage<McpRequestTrace>();

function createMcpTraceState(): McpTraceState {
  return {
    jsonRpcMethod: null,
    toolName: null,
    paymentPayloadPresent: null,
    paymentVerified: false,
    challengeIssued: false,
    paymentErrorCategory: null,
    executionStartedAt: null,
    executionFinishedAt: null,
    executionSucceeded: null,
    settlementAttempted: false,
    settlementSucceeded: null,
    settlementNetwork: null,
    settlementTransaction: null,
    handlerErrorCode: null,
    handlerErrorMessage: null,
  };
}

function getSafeErrorDetails(error: unknown): {
  name: string;
  code: string | number | null;
  message: string;
} {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const code =
    typeof candidate?.code === "string" ||
    typeof candidate?.code === "number"
      ? candidate.code
      : null;
  const rawMessage =
    typeof candidate?.message === "string"
      ? candidate.message
      : String(error);

  return {
    name:
      typeof candidate?.name === "string"
        ? candidate.name.slice(0, 100)
        : "Error",
    code,
    message: rawMessage
      .replace(/[\u0000-\u001f\u007f]/g, "?")
      .slice(0, 500),
  };
}

function logMcpLifecycle(
  event: string,
  details: Record<string, unknown> = {},
  level: "info" | "warn" | "error" = "info",
): void {
  const trace = mcpRequestContext.getStore();

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    requestId: trace?.requestId ?? null,
    journeyId: trace?.journeyId ?? null,
    journeyIdSource: trace?.journeyIdSource ?? null,
    sourceFingerprint: trace?.sourceFingerprint ?? null,
    clientFingerprint: trace?.clientFingerprint ?? null,
    userAgent: trace?.userAgent ?? null,
    ...details,
  }));
}

function recordMcpHandlerError(error: unknown): void {
  const details = getSafeErrorDetails(error);
  const trace = mcpRequestContext.getStore();

  if (trace) {
    trace.state.handlerErrorCode = details.code;
    trace.state.handlerErrorMessage = details.message;
  }

  logMcpLifecycle(
    "mcp_handler_error",
    {
      errorName: details.name,
      errorCode: details.code,
      errorMessage: details.message,
      jsonRpcMethod: trace?.state.jsonRpcMethod ?? null,
    },
    "warn",
  );
}

function recordMcpAdapterError(error: unknown): void {
  const details = getSafeErrorDetails(error);
  const trace = mcpRequestContext.getStore();

  if (trace) {
    trace.state.handlerErrorCode = details.code;
    trace.state.handlerErrorMessage = details.message;
  }

  logMcpLifecycle(
    "mcp_adapter_error",
    {
      errorName: details.name,
      errorCode: details.code,
      errorMessage: details.message,
      jsonRpcMethod: trace?.state.jsonRpcMethod ?? null,
    },
    "error",
  );
}

function getPaymentErrorCategory(result: unknown): string | null {
  if (result === null || typeof result !== "object") {
    return null;
  }

  const structuredContent = (result as {
    structuredContent?: unknown;
  }).structuredContent;

  if (
    structuredContent === null ||
    typeof structuredContent !== "object" ||
    Array.isArray(structuredContent)
  ) {
    return null;
  }

  const error = (structuredContent as { error?: unknown }).error;
  if (typeof error !== "string") {
    return null;
  }

  const normalized = error.toLowerCase();
  if (normalized.includes("settlement")) return "settlement_failed";
  if (normalized.includes("matching payment")) return "requirements_mismatch";
  if (normalized.includes("extension")) return "extension_invalid";
  if (normalized.includes("verification")) return "verification_failed";
  if (normalized.includes("payment required")) return "payment_required";
  return "payment_rejected_other";
}

const mcpPaymentHooks: NonNullable<PaymentWrapperConfig["hooks"]> = {
  onBeforeExecution: ({ toolName }) => {
    const trace = mcpRequestContext.getStore();
    const now = Date.now();

    if (trace) {
      trace.state.toolName = toolName;
      trace.state.paymentVerified = true;
      trace.state.executionStartedAt = now;
    }

    logMcpLifecycle("mcp_payment_verified", { toolName });
    logMcpLifecycle("mcp_execution_started", { toolName });
  },
  onAfterExecution: ({ toolName, result }) => {
    const trace = mcpRequestContext.getStore();
    const executionSucceeded = result.isError !== true;
    const now = Date.now();

    if (trace) {
      trace.state.executionFinishedAt = now;
      trace.state.executionSucceeded = executionSucceeded;
    }

    logMcpLifecycle("mcp_execution_finished", {
      toolName,
      executionSucceeded,
      executionMs:
        trace?.state.executionStartedAt !== null &&
        trace?.state.executionStartedAt !== undefined
          ? now - trace.state.executionStartedAt
          : null,
    });
  },
  onAfterSettlement: ({ toolName, settlement }) => {
    const trace = mcpRequestContext.getStore();
    const paymentWasAlreadyVerified = trace?.state.paymentVerified === true;
    const settlementRecord = settlement as unknown as Record<string, unknown>;
    const settlementSucceeded = settlementRecord.success === true;
    const network =
      typeof settlementRecord.network === "string"
        ? settlementRecord.network.slice(0, 100)
        : null;
    const transaction =
      typeof settlementRecord.transaction === "string"
        ? settlementRecord.transaction.slice(0, 200)
        : null;

    if (trace) {
      trace.state.paymentVerified = true;
      trace.state.settlementAttempted = true;
      trace.state.settlementSucceeded = settlementSucceeded;
      trace.state.settlementNetwork = network;
      trace.state.settlementTransaction = transaction;
    }

    if (!paymentWasAlreadyVerified) {
      logMcpLifecycle("mcp_payment_verified", {
        toolName,
        recoveredFromSettlement: true,
      });
    }

    logMcpLifecycle("mcp_payment_settled", {
      toolName,
      settlementSucceeded,
      network,
      transaction,
    });
  },
};

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

const conversionFeedbackInput = z.object({
  journeyId: z.string().regex(JOURNEY_ID_PATTERN),
  reason: z.enum(FEEDBACK_REASONS),
  stage: z
    .enum(["discovery", "preflight", "payment", "execution", "delivery"])
    .optional(),
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
  hooks: mcpPaymentHooks,
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
  hooks: mcpPaymentHooks,
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
  hooks: mcpPaymentHooks,
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
  toolName: string,
  wrapper: ReturnType<typeof createPaymentWrapper>,
) {
  return <TArgs extends Record<string, unknown>>(
    handler: PaymentWrappedHandler<TArgs>,
  ) => {
    const callback = wrapper(handler);

    return async (args: TArgs, context: ServerContext) => {
      const trace = mcpRequestContext.getStore();
      const meta = context.mcpReq._meta;
      const paymentPayloadPresent = Boolean(
        meta &&
        typeof meta === "object" &&
        (meta as Record<string, unknown>)["x402/payment"],
      );

      if (trace) {
        trace.state.toolName = toolName;
        trace.state.paymentPayloadPresent = paymentPayloadPresent;
      }

      logMcpLifecycle("mcp_tool_attempt", {
        toolName,
        paymentPayloadPresent,
      });

      let result: Awaited<ReturnType<typeof callback>>;
      try {
        result = await callback(args, {
          ...context,
          _meta: meta,
        });
      } catch (error) {
        const errorDetails = getSafeErrorDetails(error);
        const errorCategory = trace?.state.paymentVerified
          ? "execution_exception"
          : paymentPayloadPresent
            ? "payment_verification_exception"
            : "challenge_generation_exception";

        if (trace) {
          trace.state.paymentErrorCategory = errorCategory;
          if (trace.state.executionStartedAt !== null) {
            trace.state.executionFinishedAt = Date.now();
            trace.state.executionSucceeded = false;
          }
        }

        logMcpLifecycle(
          "mcp_tool_error",
          {
            toolName,
            paymentPayloadPresent,
            errorCategory,
            errorName: errorDetails.name,
            errorCode: errorDetails.code,
            errorMessage: errorDetails.message,
          },
          "error",
        );
        throw error;
      }

      const paymentErrorCategory = getPaymentErrorCategory(result);
      if (trace) {
        trace.state.paymentErrorCategory = paymentErrorCategory;
      }

      if (!paymentPayloadPresent) {
        if (trace) trace.state.challengeIssued = true;
        logMcpLifecycle("mcp_payment_challenge", { toolName });
      } else if (!trace?.state.paymentVerified) {
        logMcpLifecycle(
          "mcp_payment_verification_failed",
          { toolName, paymentErrorCategory },
          "warn",
        );
      }

      if (
        trace?.state.paymentVerified &&
        trace.state.executionSucceeded === true &&
        !trace.state.settlementAttempted
      ) {
        trace.state.settlementAttempted = true;
        trace.state.settlementSucceeded = false;
        trace.state.paymentErrorCategory ??= "settlement_failed";
        logMcpLifecycle(
          "mcp_payment_settlement_failed",
          { toolName },
          "warn",
        );
      }

      logMcpLifecycle("mcp_tool_outcome", {
        toolName,
        paymentPayloadPresent,
        paymentVerified: trace?.state.paymentVerified ?? null,
        challengeIssued: trace?.state.challengeIssued ?? null,
        paymentErrorCategory: trace?.state.paymentErrorCategory ?? null,
        executionSucceeded: trace?.state.executionSucceeded ?? null,
        settlementSucceeded: trace?.state.settlementSucceeded ?? null,
      });

      return result;
    };
  };
}

const paidConsultToolV2 =
  adaptPaymentWrapperForMcpV2("consultar_ia", paidConsultTool);
const paidAnalyzeUrlToolV2 =
  adaptPaymentWrapperForMcpV2("analisar_url", paidAnalyzeUrlTool);

const paidVerifyConditionsToolV2 =
  adaptPaymentWrapperForMcpV2(
    "verificar_condicoes",
    paidVerifyConditionsTool,
  );

const handler = createMcpHandler(() => {
  const server = new McpServer({
    name: "diogo-ai-service",
    version: SERVICE_VERSION,
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
}, {
  legacy: "stateless",
  onerror: recordMcpHandlerError,
});

type PaidRequestIntent =
  | "valid_input"
  | "invalid_input"
  | "empty_input"
  | "wrong_method"
  | null;
function getDiagnosticTargetPath(
  path: string,
): "/analyze" | "/verify-conditions" | null {
  if (path === "/analyze" || path === "/preflight/analyze") {
    return "/analyze";
  }

  if (
    path === "/verify-conditions" ||
    path === "/preflight/verify-conditions"
  ) {
    return "/verify-conditions";
  }

  return null;
}

function getRequestBodyKind(body: unknown): string {
  if (body === null) {
    return "null";
  }

  if (Array.isArray(body)) {
    return "array";
  }

  return typeof body;
}

function getSafeBodyKeys(body: unknown): string[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  return Object.keys(body)
    .sort()
    .slice(0, 20)
    .map((key) => {
      const sanitized = key
        .replace(/[^a-zA-Z0-9_-]/g, "?")
        .slice(0, 40);

      return sanitized || "<empty-key>";
    });
}

function getValidationIssues(
  path: "/analyze" | "/verify-conditions",
  body: unknown,
): string[] {
  const result =
    path === "/analyze"
      ? analyzeUrlInput.safeParse(body)
      : verifyConditionsInput.safeParse(body);

  if (result.success) {
    return [];
  }

  return result.error.issues.slice(0, 20).map((issue) => {
    const issuePath =
      issue.path.length > 0
        ? issue.path.map((part) => String(part)).join(".")
        : "body";

    return `${issuePath}:${issue.code}`;
  });
}
function getPaidRequestIntent(
  method: string,
  path: string,
  body: unknown,
): PaidRequestIntent {
  const isPaidEndpoint =
    path === "/analyze" || path === "/verify-conditions";

  if (!isPaidEndpoint) {
    return null;
  }

  if (method !== "POST") {
    return "wrong_method";
  }

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length === 0
  ) {
    return "empty_input";
  }

  const isValid =
    path === "/analyze"
      ? analyzeUrlInput.safeParse(body).success
      : verifyConditionsInput.safeParse(body).success;

  return isValid ? "valid_input" : "invalid_input";
}

function getPaidRequestDetail(
  path: string,
  body: unknown,
): string | null {
  if (path === "/analyze") {
    const parsed = analyzeUrlInput.safeParse(body);

    if (!parsed.success) {
      return null;
    }

    return parsed.data.objetivo
      ? "url_with_objective"
      : "url_only";
  }

  if (path === "/verify-conditions") {
    const parsed = verifyConditionsInput.safeParse(body);

    if (!parsed.success) {
      return null;
    }

    const count = parsed.data.condicoes.length;
    const conditionBucket =
      count === 1
        ? "one_condition"
        : count <= 3
          ? "two_to_three_conditions"
          : "four_to_ten_conditions";

    return parsed.data.contexto
      ? `${conditionBucket}_with_context`
      : conditionBucket;
  }

  return null;
}

function getHeaderSummary(req: { get(name: string): string | undefined }): {
  name: "payment-signature" | "x-payment" | null;
  present: boolean;
  encodedLength: number | null;
} {
  const paymentSignature = req.get("payment-signature");
  const legacyPayment = req.get("x-payment");
  const value = paymentSignature ?? legacyPayment;

  return {
    name: paymentSignature
      ? "payment-signature"
      : legacyPayment
        ? "x-payment"
        : null,
    present: Boolean(value),
    encodedLength: value ? Buffer.byteLength(value, "utf8") : null,
  };
}

function getSettlementResponseSummary(value: unknown): {
  present: boolean;
  parsed: boolean;
  success: boolean | null;
  network: string | null;
  transaction: string | null;
} {
  const encoded =
    typeof value === "string"
      ? value
      : Array.isArray(value) && typeof value[0] === "string"
        ? value[0]
        : null;

  if (!encoded) {
    return {
      present: false,
      parsed: false,
      success: null,
      network: null,
      transaction: null,
    };
  }

  const candidates = [
    encoded,
    Buffer.from(encoded, "base64").toString("utf8"),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      return {
        present: true,
        parsed: true,
        success:
          typeof parsed.success === "boolean" ? parsed.success : null,
        network:
          typeof parsed.network === "string"
            ? parsed.network.slice(0, 100)
            : null,
        transaction:
          typeof parsed.transaction === "string"
            ? parsed.transaction.slice(0, 200)
            : null,
      };
    } catch {
      // Try the other supported representation.
    }
  }

  return {
    present: true,
    parsed: false,
    success: null,
    network: null,
    transaction: null,
  };
}

function getInboundJourneyId(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && JOURNEY_ID_PATTERN.test(candidate) ? candidate : null;
}

function getSafeFingerprint(value: string): string {
  return createHash("sha256")
    .update(OBSERVABILITY_SALT)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 20);
}

function getSafeHeader(value: string | undefined, maxLength: number): string | null {
  if (!value) {
    return null;
  }

  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, maxLength);
}

function classifyExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }

  if (message.includes("dns") || message.includes("enotfound")) {
    return "dns_failure";
  }

  if (
    message.includes("privado") ||
    message.includes("private") ||
    message.includes("bloque")
  ) {
    return "target_blocked";
  }

  if (message.includes("limite") || message.includes("too large")) {
    return "download_limit";
  }

  if (message.includes("openai") || message.includes("provider")) {
    return "provider_failure";
  }

  if (message.includes("http") || message.includes("fetch")) {
    return "upstream_http_failure";
  }

  return "unknown_failure";
}

function getPaymentOutcome(input: {
  isPaidEndpoint: boolean;
  requestIntent: PaidRequestIntent;
  status: number;
  signaturePresent: boolean;
  paymentVerified: boolean;
  executionSucceeded: boolean | null;
  settlementResponsePresent: boolean;
  settlementSucceeded: boolean | null;
}): string | null {
  if (!input.isPaidEndpoint) {
    return null;
  }

  if (input.requestIntent !== "valid_input") {
    return "not_attempted_invalid_input";
  }

  if (!input.signaturePresent && input.status === 402) {
    return "challenge_issued";
  }

  if (input.signaturePresent && !input.paymentVerified) {
    if (input.status >= 500) {
      return "facilitator_unavailable";
    }

    return input.status === 402
      ? "verification_failed"
      : "payment_middleware_error";
  }

  if (!input.signaturePresent && input.status >= 500) {
    return "facilitator_unavailable";
  }

  if (input.paymentVerified && input.executionSucceeded === false) {
    return "execution_failed";
  }

  if (
    input.paymentVerified &&
    input.executionSucceeded === true &&
    input.settlementSucceeded === false
  ) {
    return "settlement_failed";
  }

  if (
    input.paymentVerified &&
    input.executionSucceeded === true &&
    input.status >= 400
  ) {
    return "settlement_failed";
  }

  if (
    input.paymentVerified &&
    input.executionSucceeded === true &&
    input.status < 400
  ) {
    return input.settlementResponsePresent
      ? "settled"
      : "success_without_settlement_header";
  }

  return "paid_endpoint_reached";
}

function markPaymentVerified(
  _req: unknown,
  res: { locals: Record<string, unknown> },
  next: () => void,
): void {
  res.locals.paymentVerified = true;
  res.locals.paymentVerifiedAt = Date.now();
  next();
}

const safeJsonErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const candidate = error as { status?: unknown; type?: unknown };
  const isMalformedJson =
    candidate.status === 400 && candidate.type === "entity.parse.failed";

  if (!isMalformedJson) {
    next(error);
    return;
  }

  const requestId = String(res.locals.requestId ?? randomUUID());
  const inboundJourneyId = getInboundJourneyId(req.get("x-journey-id"));
  const journeyId = String(
    res.locals.journeyId ?? inboundJourneyId ?? randomUUID(),
  );
  const userAgent = getSafeHeader(req.get("user-agent"), 300);
  const source = req.ip || req.socket.remoteAddress || "unknown";

  if (!res.headersSent) {
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-journey-id", journeyId);
  }

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    event: "request_parse_error",
    requestId,
    journeyId,
    journeyIdSource: inboundJourneyId ? "client" : "server",
    sourceFingerprint: getSafeFingerprint(source),
    clientFingerprint: getSafeFingerprint(`${source}\0${userAgent ?? ""}`),
    method: req.method,
    path: req.path,
    userAgent,
    contentType: getSafeHeader(req.get("content-type"), 120),
    bodyKind: "malformed_json",
    validationIssues: ["body:invalid_json"],
    requestIntent: "invalid_input",
    paymentOutcome: "not_attempted_invalid_input",
  }));

  res.status(400).json({
    error: "invalid_json",
    message:
      "Send syntactically valid application/json. Property names and string values must use double quotes.",
    messagePt:
      "Envie application/json sintaticamente válido. Os nomes das propriedades e os textos devem usar aspas duplas.",
    journey: {
      id: journeyId,
      header: "x-journey-id",
    },
  });
};

const app = createMcpExpressApp({ host: HOST, allowedHosts: ['localhost', '127.0.0.1', 'healthcheck.railway.app', process.env.RAILWAY_PUBLIC_DOMAIN ?? 'mcp-x402-production.up.railway.app'] });
app.set('trust proxy', 1);
app.use(helmet());
app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const inboundJourneyId = getInboundJourneyId(req.get("x-journey-id"));
  const journeyId = inboundJourneyId ?? randomUUID();
  const userAgent = getSafeHeader(req.get("user-agent"), 300);
  const source = req.ip || req.socket.remoteAddress || "unknown";
  const sourceFingerprint = getSafeFingerprint(source);
  const clientFingerprint = getSafeFingerprint(`${source}\0${userAgent ?? ""}`);
  const mcpTraceState = createMcpTraceState();
  let responseFinished = false;

  res.locals.requestId = requestId;
  res.locals.journeyId = journeyId;
  res.locals.journeyIdSource = inboundJourneyId ? "client" : "server";
  res.locals.sourceFingerprint = sourceFingerprint;
  res.locals.clientFingerprint = clientFingerprint;
  res.locals.mcpTraceState = mcpTraceState;
  res.locals.paymentVerified = false;
  res.locals.executionSucceeded = null;
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-journey-id", journeyId);

  res.on("finish", () => {
    responseFinished = true;
    const isDiscovery = DISCOVERY_PATHS.has(req.path);
    const isMcpEndpoint = req.path === "/mcp";
    const isPaidEndpoint =
      req.path === "/analyze" || req.path === "/verify-conditions";
    const isPreflightEndpoint = PREFLIGHT_PATHS.has(req.path);
    const diagnosticTargetPath = getDiagnosticTargetPath(req.path);
    const paymentHeader = getHeaderSummary(req);
    const requestIntent = diagnosticTargetPath
      ? getPaidRequestIntent(req.method, diagnosticTargetPath, req.body)
      : null;
    const paymentVerified = Boolean(res.locals.paymentVerified);
    const executionSucceeded =
      typeof res.locals.executionSucceeded === "boolean"
        ? res.locals.executionSucceeded
        : null;
    const settlementResponse = getSettlementResponseSummary(
      res.getHeader("payment-response") ??
      res.getHeader("x-payment-response"),
    );
    const settlementResponsePresent = settlementResponse.present;
    const paymentOutcome = getPaymentOutcome({
      isPaidEndpoint,
      requestIntent,
      status: res.statusCode,
      signaturePresent: paymentHeader.present,
      paymentVerified,
      executionSucceeded,
      settlementResponsePresent,
      settlementSucceeded: settlementResponse.success,
    });
    const mcpPaymentOutcome = !isMcpEndpoint ? null :
      res.statusCode >= 400 ? "transport_rejected" :
      mcpTraceState.settlementSucceeded === true ? "settled" :
      mcpTraceState.settlementAttempted && mcpTraceState.settlementSucceeded === false ? "settlement_failed" :
      mcpTraceState.executionSucceeded === false ? "execution_failed" :
      mcpTraceState.paymentVerified ? "payment_verified" :
      mcpTraceState.paymentPayloadPresent ? "verification_failed" :
      mcpTraceState.challengeIssued ? "challenge_issued" :
      "not_a_paid_tool_call";
    const funnelStage =
      isDiscovery ? "discovery" :
      isPreflightEndpoint && res.statusCode < 400 ? "preflight_ready" :
      isPreflightEndpoint ? "preflight_invalid" :
      isMcpEndpoint && res.statusCode >= 400 ? "mcp_rejection" :
      isMcpEndpoint && mcpPaymentOutcome === "settled" ? "mcp_paid_success" :
      isMcpEndpoint && mcpPaymentOutcome === "settlement_failed" ? "mcp_settlement_error" :
      isMcpEndpoint && mcpPaymentOutcome === "execution_failed" ? "mcp_execution_error" :
      isMcpEndpoint && mcpPaymentOutcome === "payment_verified" ? "mcp_payment_verified" :
      isMcpEndpoint && mcpPaymentOutcome === "verification_failed" ? "mcp_payment_verification_failed" :
      isMcpEndpoint && mcpPaymentOutcome === "challenge_issued" ? "mcp_x402_challenge" :
      isMcpEndpoint ? "mcp" :
      paymentOutcome === "settled" || paymentOutcome === "success_without_settlement_header" ? "paid_success" :
      paymentOutcome === "verification_failed" || paymentOutcome === "facilitator_unavailable" || paymentOutcome === "payment_middleware_error" || paymentOutcome === "execution_failed" || paymentOutcome === "settlement_failed" ? "paid_retry_error" :
      isPaidEndpoint && res.statusCode === 402 ? "x402_challenge" :
      isPaidEndpoint ? "paid_endpoint" :
      req.path === "/feedback" ? "feedback" :
      "other";

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "http_request",
      requestId,
      journeyId,
      journeyIdSource: res.locals.journeyIdSource,
      sourceFingerprint,
      clientFingerprint,
      method: req.method,
      path: req.path,
      targetPath: diagnosticTargetPath,
      status: res.statusCode,
      funnelStage,
      userAgent,
      contentType: getSafeHeader(req.get("content-type"), 120),
      paymentHeaderName: isPaidEndpoint ? paymentHeader.name : null,
      paymentSignaturePresent: isPaidEndpoint ? paymentHeader.present : null,
      paymentSignatureEncodedLength: isPaidEndpoint
        ? paymentHeader.encodedLength
        : null,
      paymentVerified: isPaidEndpoint ? paymentVerified : null,
      paymentVerificationMs:
        isPaidEndpoint && typeof res.locals.paymentVerifiedAt === "number"
          ? res.locals.paymentVerifiedAt - startedAt
          : null,
      paymentResponseHeaderPresent: isPaidEndpoint
        ? settlementResponsePresent
        : null,
      paymentResponseParsed: isPaidEndpoint
        ? settlementResponse.parsed
        : null,
      paymentSettlementSucceeded: isPaidEndpoint
        ? settlementResponse.success
        : null,
      paymentSettlementNetwork: isPaidEndpoint
        ? settlementResponse.network
        : null,
      paymentSettlementTransaction: isPaidEndpoint
        ? settlementResponse.transaction
        : null,
      paymentOutcome,
      mcpProtocolVersion: isMcpEndpoint
        ? getSafeHeader(req.get("mcp-protocol-version"), 100)
        : null,
      mcpJsonRpcMethod: isMcpEndpoint
        ? mcpTraceState.jsonRpcMethod
        : null,
      mcpToolName: isMcpEndpoint ? mcpTraceState.toolName : null,
      mcpPaymentPayloadPresent: isMcpEndpoint
        ? mcpTraceState.paymentPayloadPresent
        : null,
      mcpPaymentVerified: isMcpEndpoint
        ? mcpTraceState.paymentVerified
        : null,
      mcpChallengeIssued: isMcpEndpoint
        ? mcpTraceState.challengeIssued
        : null,
      mcpPaymentErrorCategory: isMcpEndpoint
        ? mcpTraceState.paymentErrorCategory
        : null,
      mcpPaymentOutcome,
      mcpExecutionSucceeded: isMcpEndpoint
        ? mcpTraceState.executionSucceeded
        : null,
      mcpExecutionMs:
        isMcpEndpoint && mcpTraceState.executionStartedAt !== null
          ? (mcpTraceState.executionFinishedAt ?? Date.now()) -
            mcpTraceState.executionStartedAt
          : null,
      mcpSettlementAttempted: isMcpEndpoint
        ? mcpTraceState.settlementAttempted
        : null,
      mcpSettlementSucceeded: isMcpEndpoint
        ? mcpTraceState.settlementSucceeded
        : null,
      mcpSettlementNetwork: isMcpEndpoint
        ? mcpTraceState.settlementNetwork
        : null,
      mcpSettlementTransaction: isMcpEndpoint
        ? mcpTraceState.settlementTransaction
        : null,
      mcpHandlerErrorCode: isMcpEndpoint
        ? mcpTraceState.handlerErrorCode
        : null,
      mcpHandlerErrorMessage: isMcpEndpoint
        ? mcpTraceState.handlerErrorMessage
        : null,
      bodyKind: diagnosticTargetPath ? getRequestBodyKind(req.body) : null,
      bodyKeys: diagnosticTargetPath ? getSafeBodyKeys(req.body) : null,
      validationIssues: diagnosticTargetPath
        ? getValidationIssues(diagnosticTargetPath, req.body)
        : null,
      requestIntent,
      requestIntentDetail: diagnosticTargetPath
        ? getPaidRequestDetail(diagnosticTargetPath, req.body)
        : null,
      executionStarted: isPaidEndpoint
        ? typeof res.locals.executionStartedAt === "number"
        : null,
      operation: isPaidEndpoint ? (res.locals.operation ?? null) : null,
      executionSucceeded: isPaidEndpoint ? executionSucceeded : null,
      executionErrorCategory: isPaidEndpoint
        ? (res.locals.executionErrorCategory ?? null)
        : null,
      executionMs:
        isPaidEndpoint && typeof res.locals.executionStartedAt === "number"
          ? (typeof res.locals.executionFinishedAt === "number"
              ? res.locals.executionFinishedAt
              : Date.now()) - res.locals.executionStartedAt
          : null,
      deliveryOutcome: "response_finished",
      durationMs: Date.now() - startedAt,
    }));
  });

  res.on("close", () => {
    if (responseFinished) {
      return;
    }

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "request_aborted",
      requestId,
      journeyId,
      sourceFingerprint,
      clientFingerprint,
      method: req.method,
      path: req.path,
      deliveryOutcome: "connection_closed_before_finish",
      durationMs: Date.now() - startedAt,
    }));
  });

  next();
});
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests. Try again later." } }));
const nodeHandler = toNodeHandler(handler, {
  onerror: recordMcpAdapterError,
});
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
        "Payment required. Send a valid JSON body. After HTTP 402, read payment-required, authorize the stated USDC payment on Base, then repeat the identical POST request. Returns summary, facts, risks and recommended actions.",
      mimeType: "application/json",
      serviceName: "MCP x402 - Evidence-Backed Web Verification",
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
            "Payment required. Send a valid JSON body with url and 1 to 10 conditions. After HTTP 402, read payment-required, authorize the stated USDC payment on Base, then repeat the identical POST request. Returns a decision per condition, textual evidence when available, verificationId and SHA-256 page hash.",
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

app.get("/", (_req, res) => {
  res.json({
    name: "MCP x402 - Evidence-Backed Web Verification",
    version: SERVICE_VERSION,
    description:
     "PT: Verificação baseada em evidência para agentes de IA antes de tomarem decisões sobre vendedores, produtos, ofertas, políticas ou afirmações. PT: Serviço MCP/x402 para análise de páginas web e verificação auditável de condições.",
    discovery: {
      x402: `${PUBLIC_SERVICE_URL}/.well-known/x402`,
      openapi: `${PUBLIC_SERVICE_URL}/openapi.json`,
      agents: `${PUBLIC_SERVICE_URL}/agents.json`,
      llms: `${PUBLIC_SERVICE_URL}/llms.txt`,
    },
    endpoints: {
      mcp: `${PUBLIC_SERVICE_URL}/mcp`,
      analyze: `POST ${PUBLIC_SERVICE_URL}/analyze`,
      verifyConditions: `POST ${PUBLIC_SERVICE_URL}/verify-conditions`,
      preflightAnalyze: `POST ${PUBLIC_SERVICE_URL}/preflight/analyze`,
      preflightVerifyConditions: `POST ${PUBLIC_SERVICE_URL}/preflight/verify-conditions`,
      feedback: `POST ${PUBLIC_SERVICE_URL}/feedback`,
      health: `${PUBLIC_SERVICE_URL}/health`,
    },
  });
});

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain; charset=utf-8").send(
    `User-agent: *
Allow: /
Sitemap: ${PUBLIC_SERVICE_URL}/.well-known/x402`,
  );
});

app.get("/.well-known/x402", (_req, res) => {
  res.json({
    x402Version: 2,
    service: {
      name: "MCP x402 - Evidence-Backed Web Verification",
      description:
        "EN: Evidence-backed verification for AI agents before acting on sellers, products, offers, policies, or claims. PT: Verificação baseada em evidência para agentes de IA antes de agirem sobre vendedores, produtos, ofertas, políticas ou afirmações.",
      url: PUBLIC_SERVICE_URL,
    },
    endpoints: [
      {
        path: "/analyze",
        method: "POST",
        price: ANALYZE_PRICE,
        network: X402_NETWORK,
        paymentHeader: "payment-required",
        description: "EN: Analyze a public web page and return a structured report with summary, facts, risks, and recommended actions. PT: Analisa uma página pública e devolve um relatório estruturado com resumo, factos, riscos e ações recomendadas.",
      },
      {
        path: "/verify-conditions",
        method: "POST",
        price: VERIFY_PRICE,
        network: X402_NETWORK,
        paymentHeader: "payment-required",
        description:
                  "EN: Verify 1 to 10 conditions about a seller, product, offer, policy, or claim before an AI agent acts. Returns a confirmed, rejected, or uncertain decision for every condition, supporting evidence when available, verificationId, and SHA-256 pageHash. PT: Verifica entre 1 e 10 condições antes de um agente de IA agir e devolve decisão e evidência auditável por condição.",
        },
        {
        path: "/mcp",
        method: "POST",
        protocol: "Model Context Protocol",
        description: "EN: MCP tools for evidence-backed verification, paid public URL analysis, and AI consultation. PT: Ferramentas MCP para verificação baseada em evidência, análise paga de URLs públicas e consulta de IA.",
      },
    ],
  });
});

app.get("/.well-known/x402.json", (_req, res) => {
  res.redirect(308, "/.well-known/x402");
});

app.get("/openapi.json", (_req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "MCP x402 - Evidence-Backed Web Verification",
      version: SERVICE_VERSION,
      description:
        "EN: x402 service for AI analysis of public web pages and auditable condition verification. Payment instructions are returned through the payment-required header. PT: Serviço x402 para análise com IA de páginas web públicas e verificação auditável de condições. As instruções de pagamento são devolvidas no cabeçalho payment-required.",
        "x-supported-languages": ["en", "pt-PT"],
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
           "/preflight/analyze": {
        post: {
          summary: "Valida gratuitamente um pedido de análise",
          description:
            "Não cobra, não descarrega a página e não executa IA. Confirma o JSON e devolve preço, rede, destino pago, próximo passo e estrutura prevista do resultado.",
          tags: ["Preflight", "URL analysis"],
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
                example: {
                  url: "https://example.com",
                  objetivo: "Resumir factos, riscos e ações recomendadas.",
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "JSON válido. Devolve preço, rede, endpoint pago, próximo passo e resultado previsto.",
            },
            "400": {
              description: "JSON inválido; devolve os campos a corrigir.",
            },
          },
        },
      },
            "/preflight/verify-conditions": {
        post: {
          summary: "Valida gratuitamente um pedido de verificação",
          description:
            "Não cobra, não descarrega a página e não executa IA. Confirma a URL e entre 1 e 10 condições, devolvendo preço, rede, destino pago, próximo passo e estrutura prevista do recibo.",
          tags: ["Preflight", "Decision verification"],
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
                      description: "Condições concretas que a página deve cumprir.",
                    },
                    contexto: {
                      type: "string",
                      description:
                        "Contexto opcional para interpretar as condições.",
                    },
                  },
                },
                example: {
                  url: "https://example.com",
                  condicoes: ["A página identifica o vendedor."],
                  contexto: "Avaliação antes de uma compra.",
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "JSON válido. Devolve preço, rede, endpoint pago, próximo passo e campos previstos do recibo.",
            },
            "400": {
              description: "JSON inválido; devolve os campos a corrigir.",
            },
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
    name: "MCP x402 - Evidence-Backed Web Verification",
    version: SERVICE_VERSION,
    description:
     "EN: MCP/x402 service for public URL analysis, AI consultation and auditable condition verification. PT: Serviço MCP/x402 para análise de URLs públicas, consulta de IA e verificação auditável de condições.",
    languages: {
     documentation: ["en", "pt-PT"],
     responseBehavior:
      "Natural-language output is returned in the same language as the request.",
},
    endpoints: {
      mcp: `${PUBLIC_SERVICE_URL}/mcp`,
      verifyConditions: `${PUBLIC_SERVICE_URL}/verify-conditions`,
      analyze: `${PUBLIC_SERVICE_URL}/analyze`,
      preflightAnalyze: `${PUBLIC_SERVICE_URL}/preflight/analyze`,
      preflightVerifyConditions: `${PUBLIC_SERVICE_URL}/preflight/verify-conditions`,
      feedback: `${PUBLIC_SERVICE_URL}/feedback`,
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
    `# MCP x402 - Evidence-Backed Web Verification

> EN: MCP/x402 service for analyzing public web pages and verifying conditions with auditable receipts.
> PT: Serviço MCP e x402 para analisar páginas web públicas e verificar condições com recibos auditáveis.

## Endpoints

- MCP: ${PUBLIC_SERVICE_URL}/mcp
- Análise paga: POST ${PUBLIC_SERVICE_URL}/analyze
- Verificação paga: POST ${PUBLIC_SERVICE_URL}/verify-conditions — decisão por condição, provas, verificationId e pageHash SHA-256
- Pré-validação gratuita da análise: POST ${PUBLIC_SERVICE_URL}/preflight/analyze — valida o JSON, informa preço e explica o próximo passo sem cobrar
- Pré-validação gratuita da verificação: POST ${PUBLIC_SERVICE_URL}/preflight/verify-conditions — valida URL e condições, informa preço e explica o próximo passo sem cobrar
- Feedback opcional da integração: POST ${PUBLIC_SERVICE_URL}/feedback — aceita apenas etapa e motivo normalizados, sem texto livre
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

app.post("/preflight/analyze", (req, res) => {
  const parsed = analyzeUrlInput.safeParse(req.body);
  const journeyId = String(res.locals.journeyId);

  if (!parsed.success) {
    res.status(400).json({
  ready: false,
  target: "/analyze",
  reason: "invalid_input",
  message:
    "Send application/json with a public HTTP(S) url. The objetivo field is optional.",
  messagePt:
    "Envie application/json com um URL público HTTP(S). O campo objetivo é opcional.",
  required: ["url"],
  optional: ["objetivo"],
  example: {
    url: "https://example.com",
    objetivo: "Summarize the page",
  },
  nextStep:
    "Correct the JSON and repeat this free preflight POST. When ready is true, send the identical body to /analyze.",
  journey: {
    id: journeyId,
    header: "x-journey-id",
    nextRequest: "Repeat this value in the x-journey-id header.",
  },
  details: z.treeifyError(parsed.error),
});
    return;
  }

  res.json({
    ready: true,
    target: {
      method: "POST",
      path: "/analyze",
      url: `${PUBLIC_SERVICE_URL}/analyze`,
    },
    validated: {
      operation: "analyze",
      objectiveProvided: Boolean(parsed.data.objetivo),
    },
    journey: {
      id: journeyId,
      header: "x-journey-id",
      nextRequest: "Repeat this value in the x-journey-id header.",
    },
    payment: {
      protocol: "x402",
      network: X402_NETWORK,
      currency: "USDC",
      price: ANALYZE_PRICE,
      nextStep:
        "Send the identical JSON body to /analyze. On HTTP 402, read payment-required, authorize the payment, then repeat the identical POST with the x402 payment signature.",
    },
    output: {
      fields: ["source", "title", "report"],
      reportSections: [
        "Summary",
        "Main facts",
        "Risks or limitations",
        "Recommended actions",
      ],
    },
    feedback: {
      optional: true,
      url: `${PUBLIC_SERVICE_URL}/feedback`,
      journeyId,
      reasons: FEEDBACK_REASONS,
    },
  });
});

app.post("/preflight/verify-conditions", (req, res) => {
  const parsed = verifyConditionsInput.safeParse(req.body);
  const journeyId = String(res.locals.journeyId);

  if (!parsed.success) {
    res.status(400).json({
  ready: false,
  target: "/verify-conditions",
  reason: "invalid_input",
  message:
    "Send application/json with a public HTTP(S) url and condicoes containing 1 to 10 strings. The contexto field is optional.",
  messagePt:
    "Envie application/json com um URL público HTTP(S) e condicoes contendo entre 1 e 10 textos. O campo contexto é opcional.",
  required: ["url", "condicoes"],
  optional: ["contexto"],
  example: {
    url: "https://example.com",
    condicoes: ["The page identifies the seller"],
    contexto: "Pre-purchase verification",
  },
  nextStep:
    "Correct the JSON and repeat this free preflight POST. When ready is true, send the identical body to /verify-conditions.",
  journey: {
    id: journeyId,
    header: "x-journey-id",
    nextRequest: "Repeat this value in the x-journey-id header.",
  },
  details: z.treeifyError(parsed.error),
});
    return;
  }

  res.json({
    ready: true,
    target: {
      method: "POST",
      path: "/verify-conditions",
      url: `${PUBLIC_SERVICE_URL}/verify-conditions`,
    },
    validated: {
      operation: "verify-conditions",
      conditionsCount: parsed.data.condicoes.length,
      contextProvided: Boolean(parsed.data.contexto),
    },
    journey: {
      id: journeyId,
      header: "x-journey-id",
      nextRequest: "Repeat this value in the x-journey-id header.",
    },
    payment: {
      protocol: "x402",
      network: X402_NETWORK,
      currency: "USDC",
      price: VERIFY_PRICE,
      nextStep:
        "Send the identical JSON body to /verify-conditions. On HTTP 402, read payment-required, authorize the payment, then repeat the identical POST with the x402 payment signature.",
    },
    output: {
      fields: [
        "source",
        "title",
        "verifiedAt",
        "decisao",
        "verificationId",
        "pageHash",
      ],
      decisionValues: ["confirmado", "rejeitado", "incerto"],
      includesEvidencePerCondition: true,
    },
    feedback: {
      optional: true,
      url: `${PUBLIC_SERVICE_URL}/feedback`,
      journeyId,
      reasons: FEEDBACK_REASONS,
    },
  });
});

app.post("/feedback", (req, res) => {
  const parsed = conversionFeedbackInput.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      accepted: false,
      error: "invalid_feedback",
      required: ["journeyId", "reason"],
      optional: ["stage"],
      allowedReasons: FEEDBACK_REASONS,
      details: z.treeifyError(parsed.error),
    });
    return;
  }

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    event: "conversion_feedback",
    requestId: res.locals.requestId,
    journeyId: parsed.data.journeyId,
    reason: parsed.data.reason,
    stage: parsed.data.stage ?? null,
    sourceFingerprint: res.locals.sourceFingerprint,
    clientFingerprint: res.locals.clientFingerprint,
  }));

  res.status(202).json({
    accepted: true,
    journeyId: parsed.data.journeyId,
  });
});

app.all("/mcp", (req, res) => {
  const body = req.body as unknown;
  const bodyKind =
    body === null ? "null" :
    Array.isArray(body) ? "array" :
    typeof body;
  const bodyRecord =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  const jsonRpcMethod =
    typeof bodyRecord?.method === "string"
      ? bodyRecord.method.slice(0, 200)
      : null;
  const params =
    bodyRecord?.params !== null &&
    typeof bodyRecord?.params === "object" &&
    !Array.isArray(bodyRecord.params)
      ? bodyRecord.params as Record<string, unknown>
      : null;
  const toolName =
    jsonRpcMethod === "tools/call" && typeof params?.name === "string"
      ? params.name
        .replace(/[^A-Za-z0-9_-]/g, "?")
        .slice(0, 100)
      : null;
  const meta =
    params?._meta !== null &&
    typeof params?._meta === "object" &&
    !Array.isArray(params._meta)
      ? params._meta as Record<string, unknown>
      : null;
  const paymentPayloadPresent =
    jsonRpcMethod === "tools/call"
      ? Boolean(meta?.["x402/payment"])
      : null;
  const state = res.locals.mcpTraceState as McpTraceState;

  state.jsonRpcMethod = jsonRpcMethod;
  state.toolName = toolName;
  state.paymentPayloadPresent = paymentPayloadPresent;

  const trace: McpRequestTrace = {
    requestId: String(res.locals.requestId),
    journeyId: String(res.locals.journeyId),
    journeyIdSource:
      res.locals.journeyIdSource === "client" ? "client" : "server",
    sourceFingerprint: String(res.locals.sourceFingerprint),
    clientFingerprint: String(res.locals.clientFingerprint),
    userAgent: getSafeHeader(req.get("user-agent"), 300),
    state,
  };

  res.on("finish", () => {
    if (res.statusCode < 400) return;

    console.log(JSON.stringify({
      level: "warn",
      timestamp: new Date().toISOString(),
      event: "mcp_rejection",
      requestId: trace.requestId,
      journeyId: trace.journeyId,
      journeyIdSource: trace.journeyIdSource,
      sourceFingerprint: trace.sourceFingerprint,
      clientFingerprint: trace.clientFingerprint,
      userAgent: trace.userAgent,
      status: res.statusCode,
      contentType: getSafeHeader(req.get("content-type"), 120),
      accept: getSafeHeader(req.get("accept"), 200),
      mcpProtocolVersion: getSafeHeader(
        req.get("mcp-protocol-version"),
        100,
      ),
      mcpSessionIdPresent: Boolean(req.get("mcp-session-id")),
      bodyKind,
      bodyKeys: getSafeBodyKeys(body),
      jsonRpcVersion: typeof bodyRecord?.jsonrpc === "string"
        ? bodyRecord.jsonrpc.slice(0, 20)
        : null,
      jsonRpcIdPresent: bodyRecord ? "id" in bodyRecord : false,
      jsonRpcMethod,
      toolName,
      paymentPayloadPresent,
      handlerErrorCode: state.handlerErrorCode,
      handlerErrorMessage: state.handlerErrorMessage,
    }));
  });

  mcpRequestContext.run(trace, () => {
    void nodeHandler(req, res, req.body).catch(recordMcpAdapterError);
  });
});

app.post(
  "/analyze",
  (req, res, next) => {
    const parsed = analyzeUrlInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
  error: "invalid_input",
  message:
    "Send application/json with a public HTTP(S) url. The objetivo field is optional.",
  messagePt:
    "Envie application/json com um URL público HTTP(S). O campo objetivo é opcional.",
  required: ["url"],
  optional: ["objetivo"],
  example: {
    url: "https://example.com",
    objetivo: "Summarize the page",
  },
  preflight: `${PUBLIC_SERVICE_URL}/preflight/analyze`,
  journey: {
    id: String(res.locals.journeyId),
    header: "x-journey-id",
    nextRequest: "Repeat this value in the x-journey-id header.",
  },
  nextStep:
    "Correct the JSON, validate it using the free preflight endpoint, then repeat this POST.",
  details: z.treeifyError(parsed.error),
});
      return;
    }

    res.locals.analyzeInput = parsed.data;
    next();
  },
  requireAnalyzePayment,
  markPaymentVerified,
  async (_req, res) => {
    res.locals.executionStartedAt = Date.now();
    res.locals.operation = "analyze";

    try {
      const input = res.locals.analyzeInput as AnalyzeUrlInput;
      const analysis = await analyzePage(input);
      res.locals.executionSucceeded = true;
      res.locals.executionFinishedAt = Date.now();
      res.json(analysis);
    } catch (error) {
      res.locals.executionSucceeded = false;
      res.locals.executionFinishedAt = Date.now();
      res.locals.executionErrorCategory = classifyExecutionError(error);
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      res.status(502).json({ error: `Falha ao analisar o URL: ${message}` });
    }
  },
);

app.post(
  "/verify-conditions",
  (req, res, next) => {
    const parsed = verifyConditionsInput.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
  error: "invalid_input",
  message:
    "Send application/json with a public HTTP(S) url and condicoes containing 1 to 10 strings. The contexto field is optional.",
  messagePt:
    "Envie application/json com um URL público HTTP(S) e condicoes contendo entre 1 e 10 textos. O campo contexto é opcional.",
  required: ["url", "condicoes"],
  optional: ["contexto"],
  example: {
    url: "https://example.com",
    condicoes: ["The page identifies the seller"],
    contexto: "Pre-purchase verification",
  },
  preflight: `${PUBLIC_SERVICE_URL}/preflight/verify-conditions`,
  journey: {
    id: String(res.locals.journeyId),
    header: "x-journey-id",
    nextRequest: "Repeat this value in the x-journey-id header.",
  },
  nextStep:
    "Correct the JSON, validate it using the free preflight endpoint, then repeat this POST.",
  details: z.treeifyError(parsed.error),
});
      return;
    }

    res.locals.verifyConditionsInput = parsed.data;
    next();
  },
  requireVerifyConditionsPayment,
  markPaymentVerified,
  async (_req, res) => {
    res.locals.executionStartedAt = Date.now();
    res.locals.operation = "verify-conditions";

    try {
      const input =
        res.locals.verifyConditionsInput as VerifyConditionsInput;
      const verification = await verifyConditions(input);
      res.locals.executionSucceeded = true;
      res.locals.executionFinishedAt = Date.now();
      res.json(verification);
    } catch (error) {
      res.locals.executionSucceeded = false;
      res.locals.executionFinishedAt = Date.now();
      res.locals.executionErrorCategory = classifyExecutionError(error);
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

app.all(["/analyze", "/verify-conditions"], (req, res) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({
    error: "method_not_allowed",
    message: `Use POST ${req.path} with application/json.`,
    messagePt: `Use POST ${req.path} com application/json.`,
    journey: {
      id: String(res.locals.journeyId),
      header: "x-journey-id",
    },
  });
});

app.use(safeJsonErrorHandler);

app.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`MCP ativo em http://${displayHost}:${PORT}/mcp`);
  console.log(`Health endpoint: http://${displayHost}:${PORT}/health`);
  console.log(
    `Analysis x402 endpoint: http://${displayHost}:${PORT}/analyze (${ANALYZE_PRICE}, Base mainnet)`,
  );
});
