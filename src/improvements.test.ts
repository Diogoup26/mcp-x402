import assert from "node:assert/strict";
import test from "node:test";
import {
  getHttpPaymentContinuation,
  getMcpPaymentContinuation,
  PUBLIC_HTTP_URL_PATTERN,
} from "./client-guidance.js";
import {
  classifyKnownToolPrePaymentRejection,
  type McpPrePaymentDiagnostic,
} from "./mcp-observability.js";
import {
  BAZAAR_TOOL_DESCRIPTIONS,
  MCP_ARGUMENT_DESCRIPTIONS,
  MCP_TOOL_DESCRIPTIONS,
} from "./tool-metadata.js";

const validDiagnostic: McpPrePaymentDiagnostic = {
  httpMethod: "POST",
  contentType: "application/json",
  status: 200,
  jsonRpcVersion: "2.0",
  jsonRpcIdPresent: true,
  jsonRpcMethod: "tools/call",
  toolName: "consultar_ia",
  argumentsValid: true,
  paymentPayloadPresent: false,
  handlerReached: false,
  challengeIssued: false,
  paymentVerified: false,
};

test("classifies known paid tool calls rejected before the handler", () => {
  assert.equal(
    classifyKnownToolPrePaymentRejection(validDiagnostic),
    "handler_not_reached",
  );
  assert.equal(
    classifyKnownToolPrePaymentRejection({
      ...validDiagnostic,
      argumentsValid: false,
    }),
    "invalid_arguments",
  );
  assert.equal(
    classifyKnownToolPrePaymentRejection({
      ...validDiagnostic,
      jsonRpcVersion: "1.0",
    }),
    "invalid_jsonrpc_envelope",
  );
  assert.equal(
    classifyKnownToolPrePaymentRejection({
      ...validDiagnostic,
      status: 400,
    }),
    "transport_or_protocol_rejected",
  );
});

test("does not classify challenges, paid retries or unknown tools", () => {
  assert.equal(
    classifyKnownToolPrePaymentRejection({
      ...validDiagnostic,
      challengeIssued: true,
    }),
    null,
  );
  assert.equal(
    classifyKnownToolPrePaymentRejection({
      ...validDiagnostic,
      paymentPayloadPresent: true,
    }),
    null,
  );
  assert.equal(
    classifyKnownToolPrePaymentRejection({
      ...validDiagnostic,
      toolName: "unknown_tool",
    }),
    null,
  );
});

test("publishes a complete and reversible x402 continuation path", () => {
  const rest = getHttpPaymentContinuation(
    "https://service.example/analyze",
    "https://service.example/preflight/analyze",
  );
  const mcp = getMcpPaymentContinuation(
    "https://service.example/mcp",
    "https://service.example/preflight/mcp",
  );

  assert.deepEqual(
    rest.steps.map((step) => step.action),
    [
      "preflight",
      "request_payment_requirements",
      "authorize_payment",
      "retry_identical_request",
      "verify_delivery",
    ],
  );
  assert.equal(mcp.steps.at(-1)?.expectedPaymentResponseSuccess, true);
  assert.equal(new RegExp(PUBLIC_HTTP_URL_PATTERN).test("https://example.com"), true);
  assert.equal(new RegExp(PUBLIC_HTTP_URL_PATTERN).test("ftp://example.com"), false);
});

test("publishes tool metadata with selection guidance and result boundaries", () => {
  assert.match(MCP_TOOL_DESCRIPTIONS.consultar_ia, /analisar_url/);
  assert.match(MCP_TOOL_DESCRIPTIONS.consultar_ia, /verificar_condicoes/);
  assert.match(MCP_TOOL_DESCRIPTIONS.analisar_url, /Não consulta fontes externas/);
  assert.match(MCP_TOOL_DESCRIPTIONS.verificar_condicoes, /verificationId/);
  assert.match(MCP_TOOL_DESCRIPTIONS.verificar_condicoes, /pageHash/);

  for (const description of Object.values(BAZAAR_TOOL_DESCRIPTIONS)) {
    assert.match(description, /^Use /);
    assert.ok(description.length >= 200);
  }

  assert.match(MCP_ARGUMENT_DESCRIPTIONS.analysisObjective, /não é tratado como prova/);
  assert.match(MCP_ARGUMENT_DESCRIPTIONS.verificationContext, /nunca como prova/);
});
