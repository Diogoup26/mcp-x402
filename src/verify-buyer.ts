import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";

const JOURNEY_ID =
  process.env.JOURNEY_ID ??
  `Diogo-Verify-${Date.now()}-${randomUUID().replace(/-/g, "")}`;
const VERIFY_ENDPOINT =
  process.env.VERIFY_ENDPOINT ??
  "https://mcp-x402-production.up.railway.app/verify-conditions";
const SERVICE_ORIGIN = new URL(VERIFY_ENDPOINT).origin;
const USER_AGENT = "Diogo-REST-Verify/1.2.3";

const [url, ...objectiveParts] = process.argv.slice(2);
const condicao = objectiveParts.join(" ").trim();

if (!url || !condicao) {
  console.error(
    'Uso: node --env-file=.env.test .\\dist\\verify-buyer.js <URL> "<condicao>"',
  );
  process.exit(1);
}

const requestBody = { url, condicoes: [condicao] };

const privateKey = process.env.EVM_PRIVATE_KEY;

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("A chave EVM_PRIVATE_KEY esta ausente ou invalida.");
}

const signer = privateKeyToAccount(privateKey as `0x${string}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

async function prepareJourney(): Promise<void> {
  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "x-journey-id": JOURNEY_ID,
  };
  const discovery = await fetch(
    `${SERVICE_ORIGIN}/.well-known/x402`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!discovery.ok) {
    throw new Error(`Descoberta falhou com HTTP ${discovery.status}.`);
  }

  const preflight = await fetch(
    `${SERVICE_ORIGIN}/preflight/verify-conditions`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    },
  );
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
      `Preflight de verificação falhou com HTTP ${preflight.status}.`,
    );
  }

  console.log("DESCOBERTA: success");
  console.log("PREFLIGHT: ready");
}

await prepareJourney();

const response = await fetchWithPayment(
  VERIFY_ENDPOINT,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "x-journey-id": JOURNEY_ID,
    },
    body: JSON.stringify(requestBody),
  },
);

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

if (!response.ok) {
  process.exitCode = 1;
}
