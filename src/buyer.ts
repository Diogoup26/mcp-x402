import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";
import {
  getEffectiveFeedbackStage,
  getFeedbackHint,
  parseFeedbackOptions,
  sendFeedback,
  shouldStopBeforePayment,
  trySendAutomaticIntegrationFeedback,
  type FeedbackStage,
} from "./feedback.js";

const JOURNEY_ID =
  process.env.JOURNEY_ID ??
  `Diogo-Analyze-${Date.now()}-${randomUUID().replace(/-/g, "")}`;
const ANALYZE_ENDPOINT =
  process.env.ANALYZE_ENDPOINT ??
  "https://mcp-x402-production.up.railway.app/analyze";
const SERVICE_ORIGIN = new URL(ANALYZE_ENDPOINT).origin;
const USER_AGENT = "Diogo-REST-Analyze/1.2.6";

let parsedCli: ReturnType<typeof parseFeedbackOptions>;
try {
  parsedCli = parseFeedbackOptions(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(getFeedbackHint());
  process.exit(1);
}

const [url, ...objectiveParts] = parsedCli.positional;
const objetivo = objectiveParts.join(" ").trim();
const feedback = parsedCli.feedback;

if (!url || !objetivo) {
  console.error(
    'Uso: node --env-file=.env.test .\\dist\\buyer.js <URL> "<objetivo>" [opções de feedback]',
  );
  console.error(getFeedbackHint());
  process.exit(1);
}

const requestBody = { url, objetivo };

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
  const preflight = await fetch(`${SERVICE_ORIGIN}/preflight/analyze`, {
    method: "POST",
    headers: { ...journeyHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await preflight.json() as {
    ready?: unknown;
    journey?: { id?: unknown };
    feedback?: { url?: unknown; reasons?: unknown };
  };
  if (
    !preflight.ok ||
    result.ready !== true ||
    result.journey?.id !== JOURNEY_ID ||
    result.feedback?.url !== `${SERVICE_ORIGIN}/feedback` ||
    !Array.isArray(result.feedback?.reasons)
  ) {
    throw new Error(
      `Preflight de análise falhou com HTTP ${preflight.status}.`,
    );
  }

  console.log("DESCOBERTA: success");
  console.log("PREFLIGHT: ready");
}

async function requestUnsignedChallenge(): Promise<void> {
  currentStage = "payment";
  const response = await fetch(ANALYZE_ENDPOINT, {
    method: "POST",
    headers: { ...journeyHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 402) {
    throw new Error(
      `Era esperado um desafio 402 sem assinatura; recebido HTTP ${response.status}.`,
    );
  }
  console.log("DESAFIO 402: recebido; pagamento não autorizado.");
  console.log(
    "FEEDBACK DISPONÍVEL:",
    response.headers.get("x-feedback-endpoint") ?? `${SERVICE_ORIGIN}/feedback`,
  );
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
    "FEEDBACK:",
    JSON.stringify({ reason: feedback.reason, stage, intent: feedback.intent }),
  );
}

async function main(): Promise<void> {
  try {
    await prepareJourney();

    if (feedback.reason && shouldStopBeforePayment(feedback)) {
      const stage = getEffectiveFeedbackStage(feedback) ?? "payment";
      if (stage === "payment") await requestUnsignedChallenge();
      await sendConfiguredFeedback(stage);
      console.log("JORNADA:", JOURNEY_ID);
      return;
    }

    const privateKey = process.env.EVM_PRIVATE_KEY;
    if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("A chave EVM_PRIVATE_KEY está ausente ou inválida.");
    }
    const signer = privateKeyToAccount(privateKey as `0x${string}`);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer });
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);

    currentStage = "payment";
    const response = await fetchWithPayment(ANALYZE_ENDPOINT, {
      method: "POST",
      headers: { ...journeyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const result = await response.text();

    console.log("JORNADA:", JOURNEY_ID);
    const paymentResponse = response.headers.get("payment-response");
    if (paymentResponse) {
      console.log(
        "PAGAMENTO:",
        Buffer.from(paymentResponse, "base64").toString("utf8"),
      );
    }
    console.log("ESTADO:", response.status);
    console.log("RESPOSTA:", result);
    console.log(
      "FEEDBACK DISPONÍVEL:",
      response.headers.get("x-feedback-endpoint") ?? `${SERVICE_ORIGIN}/feedback`,
    );

    if (feedback.reason) {
      await sendConfiguredFeedback(
        getEffectiveFeedbackStage(feedback) ?? "delivery",
      );
    } else if (response.status >= 500) {
      const sent = await trySendAutomaticIntegrationFeedback({
        serviceOrigin: SERVICE_ORIGIN,
        journeyId: JOURNEY_ID,
        userAgent: USER_AGENT,
        stage: "execution",
        intent: "analyze_page",
      });
      if (sent) console.log("FEEDBACK TÉCNICO AUTOMÁTICO: integration_error");
    }

    if (!response.ok) process.exitCode = 1;
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
        intent: "analyze_page",
      });
      if (sent) console.error("FEEDBACK TÉCNICO AUTOMÁTICO: integration_error");
    }

    console.error("ERRO:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
