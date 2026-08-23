import { randomUUID } from "node:crypto";

const SERVICE_VERSION = "1.2.2";
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
  };
  assert(
    Array.isArray(discoveryBody.endpoints) &&
      discoveryBody.endpoints.length >= 3,
    "Discovery x402 sem os endpoints esperados",
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
  };
  assert(analyzePreflightBody.ready === true, "Preflight analyze não ficou pronto");

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
    "consultar_ia",
    "analisar_url",
    "verificar_condicoes",
  ]) {
    assert(toolNames.has(expectedTool), `Ferramenta MCP ausente: ${expectedTool}`);
  }

  const toolChallenge = await expectStatus(
    "MCP paid tool challenge",
    "/mcp",
    200,
    mcpInit(
      {
        jsonrpc: "2.0",
        id: 3,
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
    structuredContent?: { accepts?: unknown[] };
  } | undefined;
  assert(toolChallengeResult?.isError === true, "Tool paga não exigiu pagamento");
  assert(
    Array.isArray(toolChallengeResult.structuredContent?.accepts),
    "Desafio MCP sem requisitos x402",
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
