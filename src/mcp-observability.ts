export const SUPPORTED_MCP_TOOL_NAMES = [
  "consultar_ia",
  "analisar_url",
  "verificar_condicoes",
] as const;

export type SupportedMcpToolName =
  (typeof SUPPORTED_MCP_TOOL_NAMES)[number];

const supportedTools = new Set<string>(SUPPORTED_MCP_TOOL_NAMES);

export type McpPrePaymentRejectionCategory =
  | "invalid_http_method"
  | "invalid_content_type"
  | "invalid_jsonrpc_envelope"
  | "invalid_arguments"
  | "transport_or_protocol_rejected"
  | "handler_not_reached";

export type McpPrePaymentDiagnostic = {
  httpMethod: string;
  contentType: string | null;
  status: number;
  jsonRpcVersion: string | null;
  jsonRpcIdPresent: boolean;
  jsonRpcMethod: string | null;
  toolName: string | null;
  argumentsValid: boolean | null;
  paymentPayloadPresent: boolean | null;
  handlerReached: boolean;
  challengeIssued: boolean;
  paymentVerified: boolean;
};

export function isSupportedMcpToolName(
  value: string | null,
): value is SupportedMcpToolName {
  return value !== null && supportedTools.has(value);
}

export function classifyKnownToolPrePaymentRejection(
  input: McpPrePaymentDiagnostic,
): McpPrePaymentRejectionCategory | null {
  if (
    input.jsonRpcMethod !== "tools/call" ||
    !isSupportedMcpToolName(input.toolName) ||
    input.paymentPayloadPresent === true ||
    input.handlerReached ||
    input.challengeIssued ||
    input.paymentVerified
  ) {
    return null;
  }

  if (input.httpMethod !== "POST") {
    return "invalid_http_method";
  }

  if (!input.contentType?.toLowerCase().includes("application/json")) {
    return "invalid_content_type";
  }

  if (input.jsonRpcVersion !== "2.0" || !input.jsonRpcIdPresent) {
    return "invalid_jsonrpc_envelope";
  }

  if (input.argumentsValid === false) {
    return "invalid_arguments";
  }

  if (input.status >= 400) {
    return "transport_or_protocol_rejected";
  }

  return "handler_not_reached";
}
