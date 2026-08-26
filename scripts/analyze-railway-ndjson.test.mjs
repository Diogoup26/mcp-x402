import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeFiles } from "./analyze-railway-ndjson.mjs";

test("covers every line, filters by time, separates traffic and reconstructs the funnel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-x402-logs-"));
  const file = join(directory, "sample.ndjson");
  const lines = [
    JSON.stringify({ timestamp: "2026-08-22T16:30:00.000Z", userAgent: "Mozilla/5.0", path: "/.well-known/x402" }),
    "",
    "not-json",
    JSON.stringify({ timestamp: "2026-08-22T16:32:00.000Z", userAgent: "Diogo-Smoke-1", journeyId: "Diogo-1", path: "/agents.json" }),
    JSON.stringify({ timestamp: "2026-08-22T16:32:10.000Z", userAgent: "RailwayHealthcheck/1.0", path: "/health", status: 200 }),
    JSON.stringify({ timestamp: "2026-08-22T16:33:00.000Z", userAgent: "Smithery Indexer", path: "/mcp", method: "POST" }),
    JSON.stringify({ timestamp: "2026-08-22T16:34:00.000Z", userAgent: "Mozilla/5.0", journeyId: "external-1", path: "/.well-known/x402" }),
    JSON.stringify({ timestamp: "2026-08-22T16:34:10.000Z", userAgent: "Mozilla/5.0", journeyId: "external-1", path: "/preflight/mcp", method: "POST", status: 200, validated: true }),
    JSON.stringify({ timestamp: "2026-08-22T16:34:20.000Z", userAgent: "Mozilla/5.0", journeyId: "external-1", status: 402, message: "Payment Required" }),
    JSON.stringify({ timestamp: "2026-08-22T16:34:30.000Z", userAgent: "Mozilla/5.0", journeyId: "external-1", event: "payment_signature_received" }),
    JSON.stringify({ timestamp: "2026-08-22T16:34:40.000Z", userAgent: "Mozilla/5.0", journeyId: "external-1", event: "payment_verified" }),
    JSON.stringify({ timestamp: "2026-08-22T16:34:50.000Z", userAgent: "Mozilla/5.0", journeyId: "external-1", event: "execution_started" }),
    JSON.stringify({ timestamp: "2026-08-22T16:35:00.000Z", userAgent: "Mozilla/5.0", journeyId: "external-1", event: "delivery_success" }),
    JSON.stringify({ timestamp: "2026-08-22T16:35:10.000Z", userAgent: "Mozilla/5.0", journeyId: "external-1", path: "/feedback", event: "feedback_received" }),
    JSON.stringify({ message: "valid JSON without timestamp" }),
  ];
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");

  const report = await analyzeFiles([file], { since: "2026-08-22T16:31:22.401228537Z" });
  const coverage = report.coverage.files[0];

  assert.equal(report.coverage.coveragePercent, 100);
  assert.equal(coverage.totalLines, lines.length);
  assert.equal(coverage.emptyLines, 1);
  assert.equal(coverage.invalidLines, 1);
  assert.equal(coverage.validJsonLines, 13);
  assert.equal(coverage.beforeSinceLines, 1);
  assert.equal(coverage.timelessValidLinesExcluded, 1);
  assert.equal(coverage.firstTimestamp, "2026-08-22T16:30:00.000Z");
  assert.equal(coverage.lastTimestamp, "2026-08-22T16:35:10.000Z");

  assert.equal(report.summary.categories.own_test, 1);
  assert.equal(report.summary.categories.railway_healthcheck, 1);
  assert.equal(report.summary.categories.probe_or_indexer, 1);
  assert.equal(report.summary.potentialExternalJourneys, 1);
  assert.equal(report.summary.validIntentJourneys, 1);
  assert.equal(report.summary.reachedPaymentChallenge, 1);
  assert.equal(report.summary.signedPayment, 1);
  assert.equal(report.summary.verifiedPayment, 1);
  assert.equal(report.summary.completedPurchases, 1);
  assert.equal(report.summary.feedbackJourneys, 1);
  assert.equal(report.summary.externalVisitors, null);

  const external = report.journeys.find((journey) => journey.id === "journey:external-1");
  assert.deepEqual(external.stages, [
    "discovery",
    "preflight",
    "valid_request",
    "challenge_402",
    "payment_signature",
    "payment_verification",
    "execution",
    "success",
    "feedback",
  ]);
  assert.equal(external.stoppedAt, "feedback");
});

test("does not count an isolated 402 as valid intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-x402-logs-"));
  const file = join(directory, "isolated-402.ndjson");
  await writeFile(
    file,
    `${JSON.stringify({ timestamp: "2026-08-26T01:00:00Z", userAgent: "Mozilla/5.0", journeyId: "external-402", status: 402 })}\n`,
    "utf8",
  );

  const report = await analyzeFiles([file]);
  assert.equal(report.summary.reachedPaymentChallenge, 1);
  assert.equal(report.summary.validIntentJourneys, 0);
  assert.equal(report.journeys[0].stoppedAt, "unclassified");
});

test("reads structured lifecycle data embedded in a Railway message field", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-x402-logs-"));
  const file = join(directory, "railway-wrapper.ndjson");
  const lifecycle = {
    timestamp: "2026-08-26T02:00:00Z",
    event: "http_request",
    journeyId: "external-embedded",
    userAgent: "Mozilla/5.0 (compatible external client)",
    path: "/mcp",
    status: 200,
    mcpArgumentsValid: true,
    mcpPaymentPayloadPresent: true,
    mcpPaymentVerified: true,
    mcpExecutionSucceeded: true,
    mcpPaymentOutcome: "settled",
    funnelStage: "mcp_paid_success",
  };
  await writeFile(
    file,
    `${JSON.stringify({ timestamp: "2026-08-26T02:00:01Z", message: JSON.stringify(lifecycle) })}\n`,
    "utf8",
  );

  const report = await analyzeFiles([file]);
  assert.equal(report.summary.validIntentJourneys, 1);
  assert.equal(report.summary.signedPayment, 1);
  assert.equal(report.summary.verifiedPayment, 1);
  assert.equal(report.summary.completedPurchases, 1);
  assert.deepEqual(report.journeys[0].stages, [
    "valid_request",
    "payment_signature",
    "payment_verification",
    "execution",
    "success",
  ]);
});

test("joins Railway HTTP rows to app rows and does not treat server journey IDs as visitors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-x402-logs-"));
  const appFile = join(directory, "app.ndjson");
  const httpFile = join(directory, "http.ndjson");
  const appRows = [
    {
      timestamp: "2026-08-26T03:00:00Z",
      event: "http_request",
      journeyId: "server-request-1",
      journeyIdSource: "server",
      clientFingerprint: "client-a",
      sourceFingerprint: "source-a",
      railwayRequestId: "edge-1",
      requestId: "internal-1",
      userAgent: "CoinbaseBazaarDiscovery/1.0",
      path: "/.well-known/x402",
      status: 200,
    },
    {
      timestamp: "2026-08-26T03:10:00Z",
      event: "http_request",
      journeyId: "server-request-2",
      journeyIdSource: "server",
      clientFingerprint: "client-a",
      sourceFingerprint: "source-a",
      railwayRequestId: "edge-2",
      requestId: "internal-2",
      userAgent: "CoinbaseBazaarDiscovery/1.0",
      path: "/openapi.json",
      status: 200,
    },
  ];
  const httpRows = [
    { timestamp: "2026-08-26T03:00:00.010Z", requestId: "edge-1", clientUa: "CoinbaseBazaarDiscovery/1.0", path: "/.well-known/x402", httpStatus: 200 },
    { timestamp: "2026-08-26T03:10:00.010Z", requestId: "edge-2", clientUa: "CoinbaseBazaarDiscovery/1.0", path: "/openapi.json", httpStatus: 200 },
  ];
  await writeFile(appFile, `${appRows.map(JSON.stringify).join("\n")}\n`, "utf8");
  await writeFile(httpFile, `${httpRows.map(JSON.stringify).join("\n")}\n`, "utf8");

  const report = await analyzeFiles([appFile, httpFile]);

  assert.equal(report.summary.categories.probe_or_indexer, 1);
  assert.equal(report.summary.potentialExternalJourneys, 0);
  assert.equal(report.summary.requests.total, 2);
  assert.equal(report.summary.requests.categories.probe_or_indexer, 2);
  assert.equal(report.summary.correlation.correlatedRequests, 2);
  assert.equal(report.summary.correlation.joinedAppAndHttpRequests, 2);
  assert.equal(report.journeys[0].eventCount, 4);
});

test("counts only accepted normalized feedback, not invalid feedback probes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-x402-logs-"));
  const file = join(directory, "feedback.ndjson");
  const rows = [
    {
      timestamp: "2026-08-26T03:00:00Z",
      event: "http_request",
      userAgent: "Mozilla/5.0",
      journeyId: "invalid-feedback",
      journeyIdSource: "client",
      path: "/feedback",
      method: "POST",
      status: 400,
    },
    {
      timestamp: "2026-08-26T03:05:00Z",
      event: "conversion_feedback",
      userAgent: "Mozilla/5.0",
      journeyId: "accepted-feedback",
      journeyIdSource: "client",
      path: "/feedback",
      method: "POST",
      status: 202,
      reason: "other",
    },
  ];
  await writeFile(file, `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");

  const report = await analyzeFiles([file]);
  const invalid = report.journeys.find((journey) => journey.id === "journey:invalid-feedback");
  const accepted = report.journeys.find((journey) => journey.id === "journey:accepted-feedback");

  assert.equal(report.summary.feedbackJourneys, 1);
  assert.equal(invalid.stages.includes("feedback"), false);
  assert.equal(accepted.stages.includes("feedback"), true);
});
