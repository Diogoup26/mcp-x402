import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";

const JOURNEY_ID =
  process.env.JOURNEY_ID ??
  `Diogo-Verify-${Date.now()}-${randomUUID().replace(/-/g, "")}`;

const [url, ...objectiveParts] = process.argv.slice(2);
const condicao = objectiveParts.join(" ").trim();

if (!url || !condicao) {
  console.error(
    'Uso: node --env-file=.env.test .\\dist\\verify-buyer.js <URL> "<condicao>"',
  );
  process.exit(1);
}

const privateKey = process.env.EVM_PRIVATE_KEY;

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("A chave EVM_PRIVATE_KEY esta ausente ou invalida.");
}

const signer = privateKeyToAccount(privateKey as `0x${string}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const response = await fetchWithPayment(
  process.env.VERIFY_ENDPOINT ?? "https://mcp-x402-production.up.railway.app/verify-conditions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Diogo-REST-Verify/1.2.2",
      "x-journey-id": JOURNEY_ID,
    },
    body: JSON.stringify({
      url,
      condicoes: [condicao],
    }),
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
