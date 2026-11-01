import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getHttpPaymentContinuation,
  getMcpPaymentContinuation,
  getPaymentDiscoveryLink,
  PUBLIC_HTTP_URL_PATTERN,
} from "./client-guidance.js";
import {
  classifyKnownToolPrePaymentRejection,
  type McpPrePaymentDiagnostic,
} from "./mcp-observability.js";
import {
  BAZAAR_OUTPUT_SCHEMAS,
  BAZAAR_TOOL_EXAMPLES,
  BAZAAR_TOOL_DESCRIPTIONS,
  MCP_ARGUMENT_DESCRIPTIONS,
  MCP_TOOL_DESCRIPTIONS,
  VERIFICATION_PREVIEW_CASES,
  VERIFICATION_USE_CASES,
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

test("publishes standards-based payment and help discovery", () => {
  assert.equal(
    getPaymentDiscoveryLink("https://service.example/"),
    '<https://service.example/.well-known/x402>; rel="payment help"; type="application/json"',
  );
});

test("publishes tool metadata with selection guidance and result boundaries", () => {
  assert.match(MCP_TOOL_DESCRIPTIONS.preview_verification, /free static preview/i);
  assert.match(MCP_TOOL_DESCRIPTIONS.preview_verification, /no web request/i);
  assert.match(MCP_TOOL_DESCRIPTIONS.preview_verification, /no.*payment/i);
  assert.match(MCP_TOOL_DESCRIPTIONS.consultar_ia, /analisar_url/);
  assert.match(MCP_TOOL_DESCRIPTIONS.consultar_ia, /verificar_condicoes/);
  assert.match(MCP_TOOL_DESCRIPTIONS.analisar_url, /does not consult other sources/i);
  assert.match(MCP_TOOL_DESCRIPTIONS.verificar_condicoes, /verificationId/);
  assert.match(MCP_TOOL_DESCRIPTIONS.verificar_condicoes, /pageHash/);
  assert.match(MCP_TOOL_DESCRIPTIONS.verificar_condicoes, /trusts, buys or acts/);
  assert.match(MCP_TOOL_DESCRIPTIONS.verificar_condicoes, /offer and warranty/i);
  assert.match(MCP_TOOL_DESCRIPTIONS.verificar_condicoes, /seller identity/i);
  assert.match(MCP_TOOL_DESCRIPTIONS.verificar_condicoes, /policy compliance/i);

  for (const description of Object.values(BAZAAR_TOOL_DESCRIPTIONS)) {
    assert.match(description, /^Use /);
    assert.ok(description.length >= 200);
  }

  assert.match(MCP_ARGUMENT_DESCRIPTIONS.analysisObjective, /não é tratado como prova/);
  assert.match(MCP_ARGUMENT_DESCRIPTIONS.verificationContext, /nunca como prova/);
});

test("publishes three free buyer-oriented verification previews", () => {
  assert.deepEqual(VERIFICATION_USE_CASES, [
    "offer_terms",
    "seller_trust",
    "policy_compliance",
  ]);

  for (const useCase of VERIFICATION_USE_CASES) {
    const preview = VERIFICATION_PREVIEW_CASES[useCase];
    assert.equal(preview.input.condicoes.length, 3);
    assert.deepEqual(
      preview.output.decisao.condicoes.map(({ estado }) => estado),
      ["confirmada", "rejeitada", "incerta"],
    );
    assert.match(preview.output.pageHash, /^sha256:[a-f0-9]{64}$/);
  }
});

test("publishes machine-readable Bazaar input and output examples", () => {
  assert.equal(
    BAZAAR_TOOL_EXAMPLES.verificar_condicoes.input.condicoes.length,
    3,
  );
  assert.deepEqual(
    BAZAAR_TOOL_EXAMPLES.verificar_condicoes.output.decisao.condicoes.map(
      ({ estado }) => estado,
    ),
    ["confirmada", "rejeitada", "incerta"],
  );

  for (const schema of Object.values(BAZAAR_OUTPUT_SCHEMAS)) {
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.length > 0);
  }

  assert.deepEqual(
    BAZAAR_OUTPUT_SCHEMAS.verificar_condicoes.properties.decisao.properties
      .decisao.enum,
    ["confirmado", "rejeitado", "incerto"],
  );
  assert.equal(
    BAZAAR_OUTPUT_SCHEMAS.verificar_condicoes.properties.pageHash.pattern,
    "^sha256:[a-f0-9]{64}$",
  );
});

test("keeps Bazaar discovery metadata within the official limits", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

  assert.match(server, /const SERVICE_NAME = "MCP x402 Verification"/);
  assert.match(server, /const VERIFICATION_DISCOVERY_TAGS = \[/);
  assert.match(server, /iconUrl: SERVICE_ICON_URL/);
  assert.match(
    server,
    /example: BAZAAR_TOOL_EXAMPLES\.verificar_condicoes\.output,[\s\S]*schema: BAZAAR_OUTPUT_SCHEMAS\.verificar_condicoes/,
  );
  assert.match(server, /VERIFICATION_PREVIEW_PATH/);
});

test("publishes the free static verification demonstration in the README", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /Free static result demonstration/);
  assert.match(readme, /Free MCP preview tool/);
  assert.match(readme, /preview_verification/);
  assert.match(readme, /offer_terms/);
  assert.match(readme, /seller_trust/);
  assert.match(readme, /policy_compliance/);
  assert.match(readme, /performs no request, OpenAI call, or[\s\S]*payment/);
  assert.match(readme, /https:\/\/shop\.example\/offers\/refurbished-laptop/);
  assert.match(readme, /"estado": "confirmada"/);
  assert.match(readme, /"estado": "rejeitada"/);
  assert.match(readme, /"estado": "incerta"/);
  assert.match(readme, /"verificationId"/);
  assert.match(readme, /"pageHash"/);
  assert.match(readme, /0\.05[\s\S]*USDC/);
});
