import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { createPaymentWrapper } from "@x402/mcp";
import { load } from "cheerio";
import OpenAI from "openai";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";
const MAX_DOWNLOAD_BYTES = 1_500_000;
const MAX_ANALYSIS_CHARS = 12_000;
const PAY_TO = "0xAe94Cc8080c9DcAF97Dda998F926ec52AF968d61";
const X402_NETWORK = "eip155:84532";
const X402_PRICE = "$0.01";
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

async function askOpenAI(prompt: string): Promise<string> {
  const response = await getOpenAIClient().responses.create({
    model: OPENAI_MODEL,
    instructions:
      "Responde em português europeu, de forma clara, correta e concisa. Usa apenas os dados fornecidos e não inventes factos. Não reveles raciocínio interno.",
    input: prompt,
  });

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
`);

  return {
    source: page.finalUrl,
    title: page.title || "Sem título",
    report,
  };
}

const facilitatorClient = new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL });
const paymentServer = new x402ResourceServer(facilitatorClient).register(
  X402_NETWORK,
  new ExactEvmScheme(),
);

await paymentServer.initialize();

const paidMcpRequirements = await paymentServer.buildPaymentRequirements({
  scheme: "exact",
  price: X402_PRICE,
  network: X402_NETWORK,
  payTo: PAY_TO,
});

const paidConsultTool = createPaymentWrapper(paymentServer, {
  accepts: paidMcpRequirements,
  resource: {
    url: "mcp://tool/consultar_ia",
    description: "Consulta paga à OpenAI.",
    serviceName: "Diogo AI Service",
    tags: ["ai", "openai"],
  },
});

const paidAnalyzeUrlTool = createPaymentWrapper(paymentServer, {
  accepts: paidMcpRequirements,
  resource: {
    url: "mcp://tool/analisar_url",
    description: "Análise paga de uma página web pública.",
    serviceName: "Diogo AI Service",
    tags: ["ai", "url-analysis", "research"],
  },
});

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
    paidConsultTool(async ({ prompt }) => {
      try {
        const answer = await askOpenAI(prompt);
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
    paidAnalyzeUrlTool(async ({ url, objetivo }) => {
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

const app = createMcpExpressApp();
const nodeHandler = toNodeHandler(handler);
const requireAnalyzePayment = paymentMiddleware(
  {
    "POST /analyze": {
      accepts: {
        scheme: "exact",
        price: X402_PRICE,
        network: X402_NETWORK,
        payTo: PAY_TO,
      },
      description:
        "Analisa uma página web pública e devolve resumo, factos, riscos e ações recomendadas.",
      mimeType: "application/json",
      serviceName: "Diogo AI URL Analysis",
      tags: ["ai", "url-analysis", "research"],
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
      price: X402_PRICE,
      network: X402_NETWORK,
    },
    paidMcpTools: [
      { name: "consultar_ia", price: X402_PRICE, network: X402_NETWORK },
      { name: "analisar_url", price: X402_PRICE, network: X402_NETWORK },
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
  console.log(`Saúde em http://${displayHost}:${PORT}/health`);
  console.log(
    `Análise x402 em http://${displayHost}:${PORT}/analyze (${X402_PRICE}, Base Sepolia)`,
  );
});
