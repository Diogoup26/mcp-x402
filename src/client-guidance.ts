export const PUBLIC_HTTP_URL_PATTERN = "^https?://[^\\s]+$";

export function getHttpPaymentContinuation(
  targetUrl: string,
  preflightUrl: string,
) {
  return {
    protocol: "x402-v2",
    automaticClient: "@x402/fetch",
    steps: [
      {
        order: 1,
        action: "preflight",
        method: "POST",
        url: preflightUrl,
        charge: false,
      },
      {
        order: 2,
        action: "request_payment_requirements",
        method: "POST",
        url: targetUrl,
        expectedStatus: 402,
        readHeader: "payment-required",
      },
      {
        order: 3,
        action: "authorize_payment",
        instruction:
          "Select an advertised requirement, verify network, asset, amount and payTo, then sign it with an x402-compatible client.",
      },
      {
        order: 4,
        action: "retry_identical_request",
        method: "POST",
        url: targetUrl,
        addHeader: "payment-signature",
      },
      {
        order: 5,
        action: "verify_delivery",
        expectedStatus: 200,
        readHeader: "payment-response",
      },
    ],
    preserveAcrossRetry: [
      "method",
      "url",
      "json_body",
      "x-journey-id",
    ],
    warning:
      "Do not send wallet private keys, Railway credentials, GitHub tokens or OpenAI keys to this service.",
  };
}

export function getMcpPaymentContinuation(
  mcpUrl: string,
  preflightUrl: string,
) {
  return {
    protocol: "x402-v2-over-mcp",
    automaticClient: "@x402/mcp",
    steps: [
      {
        order: 1,
        action: "preflight",
        method: "POST",
        url: preflightUrl,
        charge: false,
      },
      {
        order: 2,
        action: "connect",
        transport: "streamable-http",
        url: mcpUrl,
      },
      {
        order: 3,
        action: "call_tool_without_payment",
        expectedResult: "x402_payment_required",
        readField: "result.structuredContent.accepts",
      },
      {
        order: 4,
        action: "authorize_payment",
        instruction:
          "Verify network, asset, amount and payTo from the returned accepts requirements before signing.",
      },
      {
        order: 5,
        action: "retry_same_tool_call",
        addMetaField: "_meta[\"x402/payment\"]",
      },
      {
        order: 6,
        action: "verify_delivery",
        expectedPaymentResponseSuccess: true,
      },
    ],
    preserveAcrossRetry: [
      "tool_name",
      "arguments",
      "x-journey-id",
    ],
    warning:
      "Do not send wallet private keys, Railway credentials, GitHub tokens or OpenAI keys to this service.",
  };
}
