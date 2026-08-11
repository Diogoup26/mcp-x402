import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const [url, ...objectiveParts] = process.argv.slice(2);
const objetivo = objectiveParts.join(" ").trim();

if (!url || !objetivo) {
  console.error(
    'Uso: node --env-file=.env.test .\\dist\\buyer.js <URL> "<objetivo>"',
  );
  process.exit(1);
}

const privateKey = process.env.EVM_PRIVATE_KEY;

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error("A chave EVM_PRIVATE_KEY está ausente ou inválida.");
}

const signer = privateKeyToAccount(privateKey as `0x${string}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const response = await fetchWithPayment(
  "http://127.0.0.1:3000/analyze",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      url,
      objetivo,
    }),
  },
);

const result = await response.text();

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