import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";
import {
  getEffectiveFeedbackStage,
  getFeedbackHint,
  parseFeedbackOptions,
  sendFeedback,
  shouldStopBeforePayment,
  trySendAutomaticIntegrationFeedback,
  type FeedbackIntent,
  type FeedbackStage,
} from "./feedback.js";

const MCP_URL =
  process.env.MCP_ENDPOINT ??
  "https://mcp-x402-production.up.railway.app/mcp";
const SERVICE_ORIGIN = new URL(MCP_URL).origin;
const SERVICE_VERSION = "1.2.7";
const USER_AGENT = `Diogo-MCP-Buyer/${SERVICE_VERSION}`;
const NETWORK = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EXPECTED_PAY_TO = (
  process.env.X402_PAY_TO ??
  "0xAe94Cc8080c9DcAF97Dda998F926ec52AF968d61"
).toLowerCase();
const JOURNEY_ID =
  process.env.JOURNEY_ID ??
  `Diogo-MCP-${Date.now()}-${randomUUID().replace(/-/g, "")}`;

type ToolName = "analisar_url" | "consultar_ia" | "verificar_condicoes";

let parsedCli: ReturnType<typeof parseFeedbackOptions>;
try {
  parsedCli = parseFeedbackOptions(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(getFeedbackHint());
  process.exit(1);
}

const [requestedTool, ...argumentParts] = parsedCli.positional;
const feedback = parsedCli.feedback;
let tool: ToolName;
let toolArguments: Record<string, unknown>;

if (requestedTool === "analisar_url") {
  const [url, ...objectiveParts] = argumentParts;
  const objetivo = objectiveParts.join(" ").trim();
  if (!url || !objetivo) {
    console.error(
      'Uso: node --env-file=.env.test .\\dist\\mcp-buyer.js analisar_url <URL> "<objetivo>" [opções de feedback]',
    );
    console.error(getFeedbackHint());
    process.exit(1);
  }
  tool = requestedTool;
  toolArguments = { url, objetivo };
} else if (requestedTool === "consultar_ia") {
  const prompt = argumentParts.join(" ").trim();
  if (!prompt) {
    console.error(
      'Uso: node --env-file=.env.test .\\dist\\mcp-buyer.js consultar_ia "<prompt>" [opções de feedback]',
    );
    console.error(getFeedbackHint());
    process.exit(1);
  }
  tool = requestedTool;
  toolArguments = { prompt };
} else if (requestedTool === "verificar_condicoes") {
  const [url, ...conditionParts] = argumentParts;
  const condicao = conditionParts.join(" ").trim();
  if (!url || !condicao) {
    console.error(
      'Uso: node --env-file=.env.test .\\dist\\mcp-buyer.js verificar_condicoes <URL> "<condição>" [opções de feedback]',
    );
    console.error(getFeedbackHint());
    process.exit(1);
  }
  tool = requestedTool;
  toolArguments = { url, condicoes: [condicao] };
} else {
  console.error(
    'Ferramenta inválida. Use "analisar_url", "consultar_ia" ou "verificar_condicoes".',
  );
  process.exit(1);
}

const EXPECTED_PAYMENT = tool === "consultar_ia" ? 20_000n : 50_000n;
const EXPECTED_PRICE = tool === "consultar_ia" ? "$0.02" : "$0.05";
const TOOL_INTENT: FeedbackIntent =
  tool === "consultar_ia"
    ? "general_question"
    : tool === "analisar_url"
      ? "analyze_page"
      : "verify_conditions";

let currentStage: FeedbackStage = "discovery";
let feedbackAttempted = false;

const journeyHeaders = {
  Accept: "application/json",
  "User-Agent": USER_AGENT,
  "x-journey-id": JOURNEY_ID,
};

async function prepareJourney(): Promise<void> {
  currentStage = "discovery";
  const discovery = await fetch(`${SERVICE_ORIGIN}/.well-known/x402`, {
    headers: journeyHeaders,
    signal: AbortSignal.timeout(30_000),
  });
  if (!discovery.ok) {
    throw new Error(`Descoberta falhou com HTTP ${discovery.status}.`);
  }

  currentStage = "preflight";
  const preflight = await fetch(`${SERVICE_ORIGIN}/preflight/mcp`, {
    method: "POST",
    headers: { ...journeyHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ toolName: tool, arguments: toolArguments }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await preflight.json() as {
    ready?: unknown;
    target?: { url?: unknown; toolName?: unknown };
    journey?: { id?: unknown };
    payment?: { network?: unknown; price?: unknown };
    feedback?: { url?: unknown; reasons?: unknown; intents?: unknown };
  };
  if (
    !preflight.ok ||
    result.ready !== true ||
    result.target?.url !== MCP_URL ||
    result.target?.toolName !== tool ||
    result.journey?.id !== JOURNEY_ID ||
    result.payment?.network !== NETWORK ||
    result.payment?.price !== EXPECTED_PRICE ||
    result.feedback?.url !== `${SERVICE_ORIGIN}/feedback` ||
    !Array.isArray(result.feedback?.reasons) ||
    !Array.isArray(result.feedback?.intents)
  ) {
    throw new Error(`Preflight MCP falhou com HTTP ${preflight.status}.`);
  }

  console.log("DESCOBERTA MCP: success");
  console.log("PREFLIGHT MCP: ready");
  console.log("FEEDBACK DISPONÍVEL:", result.feedback.url);
}

async function sendConfiguredFeedback(stage: FeedbackStage): Promise<void> {
  if (!feedback.reason || feedbackAttempted) return;
  feedbackAttempted = true;
  await sendFeedback({
    serviceOrigin: SERVICE_ORIGIN,
    journeyId: JOURNEY_ID,
    userAgent: USER_AGENT,
    reason: feedback.reason,
    stage,
    intent: feedback.intent,
  });
  console.log(
    "FEEDBACK MCP:",
    JSON.stringify({ reason: feedback.reason, stage, intent: feedback.intent }),
  );
}

async function main(): Promise<void> {
  let connected = false;
  let client: ReturnType<typeof createx402MCPClient> | null = null;

  try {
    console.log("JORNADA MCP:", JOURNEY_ID);
    await prepareJourney();

    if (feedback.reason && shouldStopBeforePayment(feedback)) {
      await sendConfiguredFeedback(
        getEffectiveFeedbackStage(feedback) ?? "payment",
      );
      console.log("PAGAMENTO MCP: não autorizado por opção explícita de feedback");
      return;
    }

    const privateKey = process.env.EVM_PRIVATE_KEY;
    if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("A chave EVM_PRIVATE_KEY está ausente ou inválida.");
    }
    const signer = privateKeyToAccount(privateKey as `0x${string}`);

    client = createx402MCPClient({
      name: "mcp-x402-buyer",
      version: "1.0.0",
      schemes: [{ network: NETWORK, client: new ExactEvmScheme(signer) }],
      policies: [
        (_version, requirements) =>
          requirements.filter(
            (requirement) =>
              requirement.network === NETWORK &&
              requirement.asset.toLowerCase() === USDC_BASE.toLowerCase() &&
              requirement.payTo.toLowerCase() === EXPECTED_PAY_TO &&
              BigInt(requirement.amount) === EXPECTED_PAYMENT,
          ),
      ],
      autoPayment: true,
      onPaymentRequested: async ({ paymentRequired }) => {
        const allowed = paymentRequired.accepts.find(
          (requirement) =>
            requirement.network === NETWORK &&
            requirement.asset.toLowerCase() === USDC_BASE.toLowerCase() &&
            requirement.payTo.toLowerCase() === EXPECTED_PAY_TO &&
            BigInt(requirement.amount) === EXPECTED_PAYMENT,
        );
        if (!allowed) {
          console.error("Pagamento MCP recusado pelas regras de segurança.");
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
      requestInit: { headers: journeyHeaders },
    });
    currentStage = "preflight";
    await client.connect(
      transport as unknown as Parameters<typeof client.connect>[0],
    );
    connected = true;

    currentStage = "payment";
    const result = await client.callTool(tool, toolArguments);
    const paymentSettled = result.paymentResponse?.success === true;

    console.log(
      "PAGAMENTO MCP:",
      paymentSettled
        ? "success"
        : result.paymentMade
          ? "sem recibo de liquidação"
          : "não necessário",
    );
    if (result.paymentResponse) {
      console.log("RECIBO MCP:", JSON.stringify(result.paymentResponse));
    }
    console.log("RESPOSTA MCP:", JSON.stringify(result.content, null, 2));

    if (feedback.reason) {
      await sendConfiguredFeedback(
        getEffectiveFeedbackStage(feedback) ?? "delivery",
      );
    } else if (result.isError && paymentSettled) {
      const sent = await trySendAutomaticIntegrationFeedback({
        serviceOrigin: SERVICE_ORIGIN,
        journeyId: JOURNEY_ID,
        userAgent: USER_AGENT,
        stage: "execution",
        intent: TOOL_INTENT,
      });
      if (sent) console.log("FEEDBACK TÉCNICO AUTOMÁTICO: integration_error");
    } else if (result.paymentMade && !paymentSettled) {
      const sent = await trySendAutomaticIntegrationFeedback({
        serviceOrigin: SERVICE_ORIGIN,
        journeyId: JOURNEY_ID,
        userAgent: USER_AGENT,
        stage: "payment",
        intent: TOOL_INTENT,
      });
      if (sent) console.log("FEEDBACK TÉCNICO AUTOMÁTICO: integration_error");
    }

    if (result.isError || (result.paymentMade && !paymentSettled)) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (feedback.reason && !feedbackAttempted) {
      try {
        await sendConfiguredFeedback(
          getEffectiveFeedbackStage(feedback) ?? currentStage,
        );
      } catch {
        // Preserve the original failure as the primary diagnostic.
      }
    } else if (
      !feedback.reason &&
      (currentStage === "discovery" || currentStage === "preflight")
    ) {
      const sent = await trySendAutomaticIntegrationFeedback({
        serviceOrigin: SERVICE_ORIGIN,
        journeyId: JOURNEY_ID,
        userAgent: USER_AGENT,
        stage: currentStage,
        intent: TOOL_INTENT,
      });
      if (sent) console.error("FEEDBACK TÉCNICO AUTOMÁTICO: integration_error");
    }
    console.error("ERRO MCP:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (connected && client) await client.close();
  }
}

await main();
