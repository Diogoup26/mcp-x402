import { randomUUID } from "node:crypto";

const SERVICE_VERSION = "1.2.10";
const SERVICE_URL = (
  process.env.SERVICE_URL ??
  "https://mcp-x402-production.up.railway.app"
).replace(/\/$/, "");
const JOURNEY_ID =
  process.env.JOURNEY_ID ??
  `Diogo-Smoke-${Date.now()}-${randomUUID().replace(/-/g, "")}`;
const USER_AGENT = `Diogo-Smoke/${SERVICE_VERSION}`;
const checks: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", headers.get("Accept") ?? "application/json");
  headers.set("User-Agent", USER_AGENT);
  headers.set("x-journey-id", JOURNEY_ID);

  return fetch(`${SERVICE_URL}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
}

async function expectStatus(
  name: string,
  path: string,
  expectedStatus: number,
  init: RequestInit = {},
): Promise<Response> {
  const response = await request(path, init);
  assert(
    response.status === expectedStatus,
    `${name}: esperado HTTP ${expectedStatus}, recebido ${response.status}`,
  );
  const returnedJourney = response.headers.get("x-journey-id");
  assert(
    returnedJourney === JOURNEY_ID,
    `${name}: x-journey-id não foi preservado`,
  );
  checks.push(name);
  return response;
}

async function parseMcpResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  assert(text.length > 0, "Resposta MCP vazia");

  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    assert(dataLines.length > 0, "Resposta MCP SSE sem eventos data");
    return JSON.parse(dataLines.at(-1) ?? "{}") as Record<string, unknown>;
  }

  return JSON.parse(text) as Record<string, unknown>;
}

function mcpInit(body: Record<string, unknown>, protocolVersion?: string): RequestInit {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };

  if (protocolVersion) {
    headers["MCP-Protocol-Version"] = protocolVersion;
  }

  return {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
}

async function main(): Promise<void> {
  const health = await expectStatus("health", "/health", 200);
  const healthBody = await health.json() as Record<string, unknown>;
  assert(healthBody.ok === true, "Health não devolveu ok=true");

  const root = await expectStatus("runtime metadata", "/", 200);
  const rootBody = await root.json() as Record<string, unknown>;
  assert(
    rootBody.version === SERVICE_VERSION,
    `Versão runtime esperada ${SERVICE_VERSION}`,
  );

  const discovery = await expectStatus(
    "x402 discovery",
    "/.well-known/x402",
    200,
  );
  const discoveryBody = await discovery.json() as {
    endpoints?: unknown[];
    feedback?: { endpoint?: unknown; reasons?: unknown; intents?: unknown };
    continuation?: {
      analyze?: { steps?: unknown[] };
      mcp?: { automaticClient?: unknown; steps?: unknown[] };
    };
  };
  assert(
    Array.isArray(discoveryBody.endpoints) &&
      discoveryBody.endpoints.length >= 3,
    "Discovery x402 sem os endpoints esperados",
  );
  assert(
    discoveryBody.feedback?.endpoint === `${SERVICE_URL}/feedback` &&
      Array.isArray(discoveryBody.feedback.reasons) &&
      Array.isArray(discoveryBody.feedback.intents),
    "Discovery x402 sem metadata completa de feedback",
  );
  assert(
    Array.isArray(discoveryBody.continuation?.analyze?.steps) &&
      discoveryBody.continuation.analyze.steps.length === 5 &&
      discoveryBody.continuation?.mcp?.automaticClient === "@x402/mcp" &&
      Array.isArray(discoveryBody.continuation.mcp.steps) &&
      discoveryBody.continuation.mcp.steps.length === 6,
    "Discovery x402 sem percurso completo de continuação do pagamento",
  );

  const openApi = await expectStatus("OpenAPI feedback contract", "/openapi.json", 200);
  const openApiBody = await openApi.json() as {
    paths?: {
      "/verify-conditions"?: {
        post?: {
          requestBody?: {
            content?: {
              "application/json"?: { example?: { condicoes?: unknown[] } };
            };
          };
          responses?: {
            "200"?: {
              content?: {
                "application/json"?: {
                  example?: {
                    verificationId?: unknown;
                    pageHash?: unknown;
                    decisao?: { condicoes?: Array<{ estado?: unknown }> };
                  };
                };
              };
            };
          };
        };
      };
      "/feedback"?: {
        post?: {
          requestBody?: {
            content?: {
              "application/json"?: {
                schema?: {
                  required?: unknown;
                  properties?: { intent?: { enum?: unknown } };
                };
              };
            };
          };
        };
      };
    };
  };
  const feedbackSchema =
    openApiBody.paths?.["/feedback"]?.post?.requestBody?.content?.[
      "application/json"
    ]?.schema;
  assert(
    Array.isArray(feedbackSchema?.required) &&
      feedbackSchema.required.includes("journeyId") &&
      feedbackSchema.required.includes("reason") &&
      Array.isArray(feedbackSchema.properties?.intent?.enum),
    "OpenAPI não documenta completamente /feedback",
  );
  const verifyOpenApi = openApiBody.paths?.["/verify-conditions"]?.post;
  const verifyRequestExample =
    verifyOpenApi?.requestBody?.content?.["application/json"]?.example;
  const verifyResultExample =
    verifyOpenApi?.responses?.["200"]?.content?.["application/json"]?.example;
  assert(
    verifyRequestExample?.condicoes?.length === 3 &&
      verifyResultExample?.verificationId !== undefined &&
      verifyResultExample.pageHash !== undefined &&
      verifyResultExample.decisao?.condicoes?.map(({ estado }) => estado).join(",") ===
        "confirmada,rejeitada,incerta",
    "OpenAPI não publica a demonstração completa de verificar_condicoes",
  );

  const llms = await expectStatus("llms static result demonstration", "/llms.txt", 200);
  const llmsText = await llms.text();
  assert(
    llmsText.includes("Demonstração estática gratuita") &&
      llmsText.includes('"estado": "confirmada"') &&
      llmsText.includes('"estado": "rejeitada"') &&
      llmsText.includes('"estado": "incerta"') &&
      llmsText.includes('"verificationId"') &&
      llmsText.includes('"pageHash"'),
    "llms.txt não publica a demonstração completa de verificar_condicoes",
  );

  const analyzeBody = {
    url: "https://example.com",
    objetivo: "Controlled smoke test without payment.",
  };
  const analyzePreflight = await expectStatus(
    "analyze preflight",
    "/preflight/analyze",
    200,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(analyzeBody),
    },
  );
  const analyzePreflightBody = await analyzePreflight.json() as {
    ready?: unknown;
    payment?: { continuation?: { steps?: unknown[] } };
    feedback?: { url?: unknown; reasons?: unknown; intents?: unknown };
  };
  assert(analyzePreflightBody.ready === true, "Preflight analyze não ficou pronto");
  assert(
    analyzePreflightBody.feedback?.url === `${SERVICE_URL}/feedback` &&
      Array.isArray(analyzePreflightBody.feedback.reasons) &&
      Array.isArray(analyzePreflightBody.feedback.intents),
    "Preflight analyze sem instruções completas de feedback",
  );
  assert(
    analyzePreflightBody.payment?.continuation?.steps?.length === 5,
    "Preflight analyze sem continuação x402 estruturada",
  );

  const analyzeChallenge = await expectStatus(
    "analyze x402 challenge",
    "/analyze",
    402,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(analyzeBody),
    },
  );
  assert(
    Boolean(analyzeChallenge.headers.get("payment-required")),
    "Analyze 402 sem cabeçalho payment-required",
  );
  assert(
    analyzeChallenge.headers.get("x-payment-flow") === "x402-v2" &&
      analyzeChallenge.headers.get("x-payment-instructions") ===
        `${SERVICE_URL}/.well-known/x402`,
    "Analyze 402 sem ligação às instruções de continuação",
  );
  assert(
    analyzeChallenge.headers.get("link") ===
      `<${SERVICE_URL}/.well-known/x402>; rel="payment help"; type="application/json"`,
    "Analyze 402 sem Web Link normalizado para pagamento e ajuda",
  );
  assert(
    analyzeChallenge.headers.get("x-feedback-endpoint") ===
      `${SERVICE_URL}/feedback` &&
      analyzeChallenge.headers.get("x-feedback-reasons")?.includes("price"),
    "Analyze 402 sem instruções de feedback",
  );
  await analyzeChallenge.body?.cancel();

  const verifyBody = {
    url: "https://example.com",
    condicoes: ["The page identifies its purpose."],
  };
  const verifyPreflight = await expectStatus(
    "verify preflight",
    "/preflight/verify-conditions",
    200,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyBody),
    },
  );
  const verifyPreflightBody = await verifyPreflight.json() as {
    ready?: unknown;
  };
  assert(verifyPreflightBody.ready === true, "Preflight verify não ficou pronto");

  const verifyChallenge = await expectStatus(
    "verify x402 challenge",
    "/verify-conditions",
    402,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyBody),
    },
  );
  assert(
    Boolean(verifyChallenge.headers.get("payment-required")),
    "Verify 402 sem cabeçalho payment-required",
  );
  await verifyChallenge.body?.cancel();

  const mcpPreflight = await expectStatus(
    "MCP paid tool preflight",
    "/preflight/mcp",
    200,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "verificar_condicoes",
        arguments: verifyBody,
      }),
    },
  );
  const mcpPreflightBody = await mcpPreflight.json() as {
    ready?: unknown;
    target?: { url?: unknown; toolName?: unknown };
    payment?: { continuation?: { steps?: unknown[] } };
    feedback?: { url?: unknown; reasons?: unknown; intents?: unknown };
  };
  assert(mcpPreflightBody.ready === true, "Preflight MCP não ficou pronto");
  assert(
    mcpPreflightBody.target?.url === `${SERVICE_URL}/mcp`,
    "Preflight MCP não devolveu o endpoint público esperado",
  );
  assert(
    mcpPreflightBody.target?.toolName === "verificar_condicoes",
    "Preflight MCP não preservou o nome da ferramenta",
  );
  assert(
    mcpPreflightBody.feedback?.url === `${SERVICE_URL}/feedback` &&
      Array.isArray(mcpPreflightBody.feedback.reasons) &&
      Array.isArray(mcpPreflightBody.feedback.intents),
    "Preflight MCP sem instruções completas de feedback",
  );
  assert(
    mcpPreflightBody.payment?.continuation?.steps?.length === 6,
    "Preflight MCP sem continuação x402 estruturada",
  );

  const wrongMethod = await expectStatus(
    "paid endpoint method guard",
    "/analyze",
    405,
  );
  assert(
    wrongMethod.headers.get("allow") === "POST",
    "Resposta 405 sem Allow: POST",
  );
  await wrongMethod.body?.cancel();

  const initialize = await expectStatus(
    "MCP initialize 2025-06-18",
    "/mcp",
    200,
    mcpInit({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "Diogo-Smoke",
          version: SERVICE_VERSION,
        },
      },
    }),
  );
  const initializeBody = await parseMcpResponse(initialize);
  const initializeResult = initializeBody.result as {
    protocolVersion?: unknown;
    serverInfo?: { version?: unknown };
  } | undefined;
  assert(
    initializeResult?.protocolVersion === "2025-06-18",
    "MCP não negociou 2025-06-18",
  );
  assert(
    initializeResult.serverInfo?.version === SERVICE_VERSION,
    "Versão MCP não coincide com a versão de serviço",
  );

  const initialized = await expectStatus(
    "MCP initialized notification",
    "/mcp",
    202,
    mcpInit(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      "2025-06-18",
    ),
  );
  await initialized.body?.cancel();

  const listTools = await expectStatus(
    "MCP tools/list",
    "/mcp",
    200,
    mcpInit(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      "2025-06-18",
    ),
  );
  const listToolsBody = await parseMcpResponse(listTools);
  const tools = (listToolsBody.result as { tools?: unknown[] } | undefined)?.tools;
  assert(Array.isArray(tools), "tools/list não devolveu uma lista");
  const toolNames = new Set(
    tools
      .map((tool) =>
        tool !== null &&
        typeof tool === "object" &&
        typeof (tool as { name?: unknown }).name === "string"
          ? (tool as { name: string }).name
          : null,
      )
      .filter((name): name is string => name !== null),
  );
  for (const expectedTool of [
    "preview_verification",
    "consultar_ia",
    "analisar_url",
    "verificar_condicoes",
  ]) {
    assert(toolNames.has(expectedTool), `Ferramenta MCP ausente: ${expectedTool}`);
  }
  const verificationTool = tools.find(
    (tool) =>
      tool !== null &&
      typeof tool === "object" &&
      (tool as { name?: unknown }).name === "verificar_condicoes",
  ) as {
    outputSchema?: { required?: unknown[] };
    annotations?: {
      readOnlyHint?: unknown;
      destructiveHint?: unknown;
      openWorldHint?: unknown;
    };
  } | undefined;
  assert(
    Array.isArray(verificationTool?.outputSchema?.required) &&
      verificationTool.outputSchema.required.includes("pageHash") &&
      verificationTool.outputSchema.required.includes("decisao"),
    "Ferramenta de verificação sem outputSchema estruturado",
  );
  assert(
    verificationTool?.annotations?.readOnlyHint === true &&
      verificationTool.annotations.destructiveHint === false &&
      verificationTool.annotations.openWorldHint === true,
    "Ferramenta de verificação sem annotations de segurança corretas",
  );

  const previewTool = tools.find(
    (tool) =>
      tool !== null &&
      typeof tool === "object" &&
      (tool as { name?: unknown }).name === "preview_verification",
  ) as {
    outputSchema?: { required?: unknown[] };
    annotations?: {
      readOnlyHint?: unknown;
      destructiveHint?: unknown;
      openWorldHint?: unknown;
    };
  } | undefined;
  assert(
    Array.isArray(previewTool?.outputSchema?.required) &&
      previewTool.outputSchema.required.includes("exampleInput") &&
      previewTool.outputSchema.required.includes("exampleOutput") &&
      previewTool.outputSchema.required.includes("paymentRequired"),
    "Preview gratuito sem outputSchema estruturado",
  );
  assert(
    previewTool?.annotations?.readOnlyHint === true &&
      previewTool.annotations.destructiveHint === false &&
      previewTool.annotations.openWorldHint === false,
    "Preview gratuito sem annotations de segurança corretas",
  );

  const previewResponse = await expectStatus(
    "MCP free verification preview",
    "/mcp",
    200,
    mcpInit(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "preview_verification",
          arguments: { useCase: "seller_trust" },
        },
      },
      "2025-06-18",
    ),
  );
  const previewResponseBody = await parseMcpResponse(previewResponse);
  const previewResult = previewResponseBody.result as {
    isError?: unknown;
    structuredContent?: {
      kind?: unknown;
      useCase?: unknown;
      liveRequestPerformed?: unknown;
      openAiUsed?: unknown;
      paymentRequired?: unknown;
      paidTool?: unknown;
      exampleOutput?: { pageHash?: unknown; decisao?: unknown };
    };
  } | undefined;
  assert(
    previewResult?.isError !== true &&
      previewResult?.structuredContent?.kind === "static_example" &&
      previewResult.structuredContent.useCase === "seller_trust" &&
      previewResult.structuredContent.liveRequestPerformed === false &&
      previewResult.structuredContent.openAiUsed === false &&
      previewResult.structuredContent.paymentRequired === false &&
      previewResult.structuredContent.paidTool === "verificar_condicoes" &&
      typeof previewResult.structuredContent.exampleOutput?.pageHash === "string" &&
      previewResult.structuredContent.exampleOutput.decisao !== undefined,
    "Preview gratuito não devolveu o contrato estático esperado",
  );

  const toolChallenge = await expectStatus(
    "MCP paid tool challenge",
    "/mcp",
    200,
    mcpInit(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "verificar_condicoes",
          arguments: verifyBody,
        },
      },
      "2025-06-18",
    ),
  );
  const toolChallengeBody = await parseMcpResponse(toolChallenge);
  const toolChallengeResult = toolChallengeBody.result as {
    isError?: unknown;
    structuredContent?: {
      accepts?: unknown[];
      resource?: { url?: unknown };
      extensions?: {
        bazaar?: {
          info?: {
            input?: { type?: unknown; toolName?: unknown };
            output?: { example?: unknown };
          };
          schema?: { properties?: { output?: unknown } };
        };
      };
    };
  } | undefined;
  assert(toolChallengeResult?.isError === true, "Tool paga não exigiu pagamento");
  assert(
    Array.isArray(toolChallengeResult.structuredContent?.accepts),
    "Desafio MCP sem requisitos x402",
  );
  const advertisedMcpUrl = toolChallengeResult.structuredContent?.resource?.url;
  assert(
    advertisedMcpUrl === `${SERVICE_URL}/mcp`,
    "Desafio MCP não anunciou o endpoint HTTPS público",
  );
  assert(
    new URL(String(advertisedMcpUrl)).protocol === "https:",
    "Metadata MCP/Bazaar não usa HTTPS",
  );
  const bazaarInput =
    toolChallengeResult.structuredContent?.extensions?.bazaar?.info?.input;
  assert(bazaarInput?.type === "mcp", "Extensão Bazaar não declarou type=mcp");
  assert(
    bazaarInput?.toolName === "verificar_condicoes",
    "Extensão Bazaar não preservou o toolName",
  );
  const bazaarOutput =
    toolChallengeResult.structuredContent?.extensions?.bazaar?.info?.output;
  const bazaarOutputSchema =
    toolChallengeResult.structuredContent?.extensions?.bazaar?.schema?.properties
      ?.output;
  assert(
    bazaarOutput?.example !== undefined &&
      bazaarOutputSchema !== undefined,
    "Extensão Bazaar MCP sem exemplo e schema de output",
  );
  assert(
    toolChallenge.headers.get("x-feedback-endpoint") ===
      `${SERVICE_URL}/feedback` &&
      toolChallenge.headers.get("x-feedback-intents")?.includes(
        "verify_conditions",
      ),
    "Desafio MCP sem instruções de feedback",
  );

  const feedbackResponse = await expectStatus(
    "explicit normalized feedback",
    "/feedback",
    202,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        journeyId: JOURNEY_ID,
        reason: "other",
        stage: "delivery",
        intent: "evaluate_service",
      }),
    },
  );
  const feedbackBody = await feedbackResponse.json() as {
    accepted?: unknown;
    intent?: unknown;
    automatic?: unknown;
  };
  assert(
    feedbackBody.accepted === true &&
      feedbackBody.intent === "evaluate_service" &&
      feedbackBody.automatic === false,
    "Endpoint /feedback não preservou o feedback normalizado",
  );

  console.log(JSON.stringify({
    ok: true,
    serviceUrl: SERVICE_URL,
    userAgent: USER_AGENT,
    journeyId: JOURNEY_ID,
    checksPassed: checks.length,
    checks,
    paymentMade: false,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    ok: false,
    serviceUrl: SERVICE_URL,
    userAgent: USER_AGENT,
    journeyId: JOURNEY_ID,
    checksPassed: checks.length,
    checks,
    paymentMade: false,
    error: message,
  }, null, 2));
  process.exitCode = 1;
}
