import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";

const MCP_URL =
  process.env.MCP_ENDPOINT ??
  "https://mcp-x402-production.up.railway.app/mcp";
const SERVICE_ORIGIN = new URL(MCP_URL).origin;
const SERVICE_VERSION = "1.2.3";
const USER_AGENT = `Diogo-MCP-Buyer/${SERVICE_VERSION}`;
const NETWORK = "eip155:8453";
const MAX_PAYMENT = 50_000n;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const JOURNEY_ID =
  process.env.JOURNEY_ID ??
  `Diogo-MCP-${Date.now()}-${randomUUID().replace(/-/g, "")}`;

type ToolName =
  | "analisar_url"
  | "consultar_ia"
  | "verificar_condicoes";

const [requestedTool, ...argumentParts] = process.argv.slice(2);

let tool: ToolName;
let toolArguments: Record<string, unknown>;

if (requestedTool === "analisar_url") {
  const [url, ...objectiveParts] = argumentParts;
  const objetivo = objectiveParts.join(" ").trim();

  if (!url || !objetivo) {
    console.error(
      'Uso: node --env-file=.env.test .\\dist\\mcp-buyer.js analisar_url <URL> "<objetivo>"',
    );
    process.exit(1);
  }

  tool = requestedTool;
  toolArguments = { url, objetivo };
} else if (requestedTool === "consultar_ia") {
  const prompt = argumentParts.join(" ").trim();

  if (!prompt) {
    console.error(
      'Uso: node --env-file=.env.test .\\dist\\mcp-buyer.js consultar_ia "<prompt>"',
    );
    process.exit(1);
  }

  tool = requestedTool;
  toolArguments = { prompt };
} else if (requestedTool === "verificar_condicoes") {
  const [url, ...conditionParts] = argumentParts;
  const condicao = conditionParts.join(" ").trim();

  if (!url || !condicao) {
    console.error(
      'Uso: node --env-file=.env.test .\\dist\\mcp-buyer.js verificar_condicoes <URL> "<condicao>"',
    );
    process.exit(1);
  }

  tool = requestedTool;
  toolArguments = { url, condicoes: [condicao] };
} else {
  console.error(
    'Ferramenta invalida. Use "analisar_url", "consultar_ia" ou "verificar_condicoes".',
  );
  process.exit(1);
}
const privateKey = process.env.EVM_PRIVATE_KEY;

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error(
    "A chave EVM_PRIVATE_KEY esta ausente ou invalida.",
  );
}

const signer = privateKeyToAccount(privateKey as `0x${string}`);

async function prepareJourney(): Promise<void> {
  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "x-journey-id": JOURNEY_ID,
  };
  const discovery = await fetch(
    `${SERVICE_ORIGIN}/.well-known/x402`,
    {
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!discovery.ok) {
    throw new Error(`Descoberta falhou com HTTP ${discovery.status}.`);
  }

  const preflight = await fetch(`${SERVICE_ORIGIN}/preflight/mcp`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      toolName: tool,
      arguments: toolArguments,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await preflight.json() as {
    ready?: unknown;
    journey?: { id?: unknown };
  };
  if (
    !preflight.ok ||
    result.ready !== true ||
    result.journey?.id !== JOURNEY_ID
  ) {
    throw new Error(
      `Preflight MCP falhou com HTTP ${preflight.status}.`,
    );
  }

  console.log("DESCOBERTA MCP: success");
  console.log("PREFLIGHT MCP: ready");
}

const client = createx402MCPClient({
  name: "mcp-x402-buyer",
  version: "1.0.0",
  schemes: [
    {
      network: NETWORK,
      client: new ExactEvmScheme(signer),
    },
  ],
  policies: [
    (_version, requirements) =>
      requirements.filter(
        (requirement) =>
          requirement.network === NETWORK &&
          requirement.asset.toLowerCase() ===
            USDC_BASE.toLowerCase() &&
          BigInt(requirement.amount) <= MAX_PAYMENT,
      ),
  ],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => {
    const allowed = paymentRequired.accepts.find(
      (requirement) =>
        requirement.network === NETWORK &&
        requirement.asset.toLowerCase() ===
          USDC_BASE.toLowerCase() &&
        BigInt(requirement.amount) <= MAX_PAYMENT,
    );

    if (!allowed) {
      console.error("Pagamento MCP recusado pelas regras de seguranca.");
      return false;
    }

    console.log(
      "PAGAMENTO MCP PEDIDO:",
      JSON.stringify({
        amount: allowed.amount,
        asset: allowed.asset,
        network: allowed.network,
        payTo: allowed.payTo,
      }),
    );

    return true;
  },
});

const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: {
    headers: {
      "User-Agent": USER_AGENT,
      "x-journey-id": JOURNEY_ID,
    },
  },
});
let connected = false;

try {
  console.log("JORNADA MCP:", JOURNEY_ID);
  await prepareJourney();
  await client.connect(
    transport as unknown as Parameters<typeof client.connect>[0],
  );
  connected = true;
  const result = await client.callTool(tool, toolArguments);

    const paymentSettled =
    result.paymentResponse?.success === true;

  console.log(
    "PAGAMENTO MCP:",
    paymentSettled
      ? "success"
      : result.paymentMade
        ? "sem recibo de liquidacao"
        : "nao necessario",
  );

  if (result.paymentResponse) {
    console.log(
      "RECIBO MCP:",
      JSON.stringify(result.paymentResponse),
    );
  }

  console.log(
    "RESPOSTA MCP:",
    JSON.stringify(result.content, null, 2),
  );

  if (
    result.isError ||
    (result.paymentMade && !paymentSettled)
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : String(error);
  console.error("ERRO MCP:", message);
  process.exitCode = 1;
} finally {
  if (connected) {
    await client.close();
  }
}
