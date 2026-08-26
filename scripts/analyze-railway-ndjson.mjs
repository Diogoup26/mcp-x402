#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const FUNNEL_STAGES = [
  "discovery",
  "preflight",
  "valid_request",
  "challenge_402",
  "payment_signature",
  "payment_verification",
  "execution",
  "success",
  "error",
  "feedback",
];

const KEY_GROUPS = {
  timestamp: ["timestamp", "@timestamp", "time", "createdat", "eventtimestamp"],
  journeyId: ["journeyid", "xjourneyid"],
  clientFingerprint: ["clientfingerprint"],
  sourceFingerprint: ["sourcefingerprint"],
  requestId: ["requestid", "xrequestid"],
  userAgent: ["useragent"],
  path: ["path", "requestpath", "route", "url"],
  method: ["method", "httpmethod"],
  status: ["status", "statuscode", "httpstatus"],
};

const PROBE_MARKERS = /(?:smithery|glama|coinbase|bazaar|allmcps|mcp\.so|pulsemcp|agentndx|crawler|spider|indexer|monitor|probe|uptime|bot\b)/i;

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9@]/g, "");
}

function embeddedObjects(value) {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? [parsed] : [];
  } catch {
    return [];
  }
}

function collectValues(root, acceptedKeys) {
  const accepted = new Set(acceptedKeys.map(normalizedKey));
  const values = [];
  const seen = new Set();

  function visit(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (accepted.has(normalizedKey(key)) && ["string", "number", "boolean"].includes(typeof child)) {
        values.push(String(child));
      }
      if (typeof child === "object" && child !== null) visit(child, depth + 1);
      for (const embedded of embeddedObjects(child)) visit(embedded, depth + 1);
    }
  }

  visit(root);
  return [...new Set(values)];
}

function firstValue(record, group) {
  return collectValues(record, KEY_GROUPS[group])[0] ?? null;
}

function canonicalTimestamp(value) {
  if (!value || typeof value !== "string") return null;
  const timestamp = value.trim();
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? timestamp : null;
}

function extractTimestamp(record) {
  for (const value of collectValues(record, KEY_GROUPS.timestamp)) {
    const timestamp = canonicalTimestamp(value);
    if (timestamp) return timestamp;
  }
  return null;
}

function numericStatuses(record) {
  return collectValues(record, KEY_GROUPS.status)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite);
}

function searchableText(record) {
  const chunks = [JSON.stringify(record)];
  const seen = new Set();

  function visit(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const embedded of embeddedObjects(value)) {
        chunks.push(JSON.stringify(embedded));
        visit(embedded, depth + 1);
      }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  }

  visit(record);
  return chunks.join(" ").toLowerCase();
}

function classifyTraffic(record) {
  const userAgents = collectValues(record, KEY_GROUPS.userAgent);
  const journeyIds = collectValues(record, KEY_GROUPS.journeyId);
  const combined = [...userAgents, ...journeyIds].join(" ");

  if (userAgents.some((value) => /^Diogo-/i.test(value)) || journeyIds.some((value) => /^Diogo-/i.test(value))) {
    return "own_test";
  }
  if (userAgents.some((value) => /RailwayHealthcheck/i.test(value))) return "railway_healthcheck";
  if (PROBE_MARKERS.test(combined)) return "probe_or_indexer";
  if (userAgents.length > 0) return "potential_external";
  return "unknown";
}

function detectStages(record) {
  const text = searchableText(record);
  const statuses = numericStatuses(record);
  const paths = collectValues(record, KEY_GROUPS.path).map((value) => value.toLowerCase());
  const methods = collectValues(record, KEY_GROUPS.method).map((value) => value.toUpperCase());
  const stages = new Set();

  if (
    paths.some((value) => /(?:agents\.json|llms\.txt|\.well-known|openapi|swagger)/.test(value)) ||
    /(?:"method"\s*:\s*"initialize"|tools\/list|discovery_(?:request|success)|runtime_discovery)/.test(text)
  ) stages.add("discovery");

  if (paths.some((value) => value.includes("preflight")) || /preflight_(?:request|ready|success|validated)/.test(text)) {
    stages.add("preflight");
  }

  if (
    /(?:request_validated|validation_success|"validated"\s*:\s*true|"requestintent"\s*:\s*"valid_input"|"mcpargumentsvalid"\s*:\s*true|preflight_(?:ready|success))/.test(text) ||
    (methods.includes("POST") && paths.some((value) => value.includes("preflight")) && statuses.some((value) => value >= 200 && value < 300))
  ) stages.add("valid_request");

  if (statuses.includes(402) || /(?:payment required|challenge_402|payment_challenge)/.test(text)) stages.add("challenge_402");
  if (/(?:payment-signature|x-payment|payment_signature|signature_received|payment_payload_received|"paymentsignaturepresent"\s*:\s*true|"mcppaymentpayloadpresent"\s*:\s*true)/.test(text)) {
    stages.add("payment_signature");
  }
  if (/(?:payment_verified|payment_verification|verify_payment|settlement_(?:success|confirmed)|payment_settled|"paymentverified"\s*:\s*true|"mcppaymentverified"\s*:\s*true)/.test(text)) {
    stages.add("payment_verification");
  }
  if (/(?:execution_(?:started|success|failed)|tool_execution|executing_tool|tool_call_started|"executionstartedat"\s*:\s*\d+|"mcpexecutionsucceeded"\s*:\s*(?:true|false))/.test(text)) stages.add("execution");
  if (/(?:delivery_success|request_succeeded|tool_success|execution_success|final_success|"funnelstage"\s*:\s*"(?:paid_success|mcp_paid_success)"|"(?:paymentoutcome|mcppaymentoutcome)"\s*:\s*"settled")/.test(text)) stages.add("success");
  if (statuses.some((value) => value >= 400 && value !== 402) || /(?:final_error|execution_failed|delivery_error|request_failed|paid_retry_error|mcp_(?:settlement|execution)_error)/.test(text)) {
    stages.add("error");
  }
  if (paths.some((value) => value.includes("/feedback")) || /feedback_(?:received|stored|submitted)/.test(text)) stages.add("feedback");

  return [...stages];
}

function eventIdentity(record) {
  return {
    journeyId: firstValue(record, "journeyId"),
    clientFingerprint: firstValue(record, "clientFingerprint"),
    sourceFingerprint: firstValue(record, "sourceFingerprint"),
    requestId: firstValue(record, "requestId"),
    userAgent: firstValue(record, "userAgent"),
  };
}

function sessionKey(event) {
  const identity = event.identity;
  if (identity.journeyId) return `journey:${identity.journeyId}`;
  if (identity.clientFingerprint || identity.sourceFingerprint) {
    return `fingerprint:${identity.clientFingerprint ?? "-"}:${identity.sourceFingerprint ?? "-"}`;
  }
  if (identity.requestId) return `request:${identity.requestId}`;
  if (identity.userAgent) return `ua:${identity.userAgent}`;
  return `line:${event.file}:${event.line}`;
}

function reconstructJourneys(events, sessionMinutes = 15) {
  const buckets = new Map();
  for (const event of events) {
    const key = sessionKey(event);
    const timestampMs = Date.parse(event.timestamp);
    const candidates = buckets.get(key) ?? [];
    let journey = candidates.at(-1);
    if (!journey || timestampMs - journey.lastTimestampMs > sessionMinutes * 60_000) {
      journey = {
        id: candidates.length === 0 ? key : `${key}#${candidates.length + 1}`,
        category: event.category,
        firstTimestamp: event.timestamp,
        lastTimestamp: event.timestamp,
        lastTimestampMs: timestampMs,
        identity: { ...event.identity },
        stages: new Set(),
        events: [],
      };
      candidates.push(journey);
      buckets.set(key, candidates);
    }

    journey.lastTimestamp = event.timestamp;
    journey.lastTimestampMs = timestampMs;
    if (journey.category === "unknown" && event.category !== "unknown") journey.category = event.category;
    for (const [field, value] of Object.entries(event.identity)) {
      if (!journey.identity[field] && value) journey.identity[field] = value;
    }
    for (const stage of event.stages) journey.stages.add(stage);
    journey.events.push({ file: event.file, line: event.line, timestamp: event.timestamp, stages: event.stages });
  }

  return [...buckets.values()].flat().map((journey) => {
    const stages = FUNNEL_STAGES.filter((stage) => journey.stages.has(stage));
    const stoppingCandidates = stages.filter((stage) => stage !== "challenge_402" || stages.includes("valid_request"));
    return {
      id: journey.id,
      category: journey.category,
      firstTimestamp: journey.firstTimestamp,
      lastTimestamp: journey.lastTimestamp,
      identity: journey.identity,
      stages,
      stoppedAt: stoppingCandidates.at(-1) ?? "unclassified",
      eventCount: journey.events.length,
      events: journey.events,
    };
  });
}

function summarizeJourneys(journeys) {
  const categories = Object.fromEntries(
    ["own_test", "railway_healthcheck", "probe_or_indexer", "potential_external", "unknown"].map((category) => [
      category,
      journeys.filter((journey) => journey.category === category).length,
    ]),
  );
  const external = journeys.filter((journey) => journey.category === "potential_external");
  const funnel = Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, external.filter((journey) => journey.stages.includes(stage)).length]));
  const stoppedAt = {};
  for (const journey of external) stoppedAt[journey.stoppedAt] = (stoppedAt[journey.stoppedAt] ?? 0) + 1;

  return {
    categories,
    potentialExternalJourneys: external.length,
    externalVisitors: null,
    externalVisitorsLimitation: "Journey correlation does not prove a stable human identity.",
    validIntentJourneys: funnel.valid_request,
    isolated402IsIntent: false,
    reachedPaymentChallenge: funnel.challenge_402,
    signedPayment: funnel.payment_signature,
    verifiedPayment: funnel.payment_verification,
    completedPurchases: funnel.success,
    feedbackJourneys: funnel.feedback,
    funnel,
    stoppedAt,
  };
}

function splitPhysicalLines(text) {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export async function analyzeFiles(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) throw new Error("At least one NDJSON file is required.");
  const sinceMs = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
  if (options.since && !Number.isFinite(sinceMs)) throw new Error(`Invalid --since timestamp: ${options.since}`);

  const files = [];
  const events = [];

  for (const filePath of filePaths) {
    const source = await readFile(filePath, "utf8");
    const lines = splitPhysicalLines(source);
    const stats = {
      file: filePath,
      totalLines: lines.length,
      emptyLines: 0,
      validJsonLines: 0,
      invalidLines: 0,
      timestampedLines: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      analyzedLines: 0,
      analyzedFirstTimestamp: null,
      analyzedLastTimestamp: null,
      beforeSinceLines: 0,
      timelessValidLinesExcluded: 0,
      invalidLineNumbers: [],
    };

    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      if (index === 0) line = line.replace(/^\uFEFF/, "");
      if (line.trim().length === 0) {
        stats.emptyLines += 1;
        continue;
      }

      let record;
      try {
        record = JSON.parse(line);
        stats.validJsonLines += 1;
      } catch {
        stats.invalidLines += 1;
        if (stats.invalidLineNumbers.length < 20) stats.invalidLineNumbers.push(index + 1);
        continue;
      }

      const timestamp = extractTimestamp(record);
      if (!timestamp) {
        stats.timelessValidLinesExcluded += 1;
        continue;
      }
      stats.timestampedLines += 1;
      if (!stats.firstTimestamp || Date.parse(timestamp) < Date.parse(stats.firstTimestamp)) stats.firstTimestamp = timestamp;
      if (!stats.lastTimestamp || Date.parse(timestamp) > Date.parse(stats.lastTimestamp)) stats.lastTimestamp = timestamp;

      const timestampMs = Date.parse(timestamp);
      if (timestampMs < sinceMs) {
        stats.beforeSinceLines += 1;
        continue;
      }

      stats.analyzedLines += 1;
      if (!stats.analyzedFirstTimestamp || timestampMs < Date.parse(stats.analyzedFirstTimestamp)) stats.analyzedFirstTimestamp = timestamp;
      if (!stats.analyzedLastTimestamp || timestampMs > Date.parse(stats.analyzedLastTimestamp)) stats.analyzedLastTimestamp = timestamp;
      events.push({
        file: filePath,
        line: index + 1,
        timestamp,
        category: classifyTraffic(record),
        identity: eventIdentity(record),
        stages: detectStages(record),
      });
    }

    files.push(stats);
  }

  events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.file.localeCompare(b.file) || a.line - b.line);
  const journeys = reconstructJourneys(events, options.sessionMinutes ?? 15);

  return {
    generatedAt: new Date().toISOString(),
    analyzedSince: options.since ?? null,
    coverage: {
      filesAnalyzed: files.length,
      totalLinesRead: files.reduce((sum, file) => sum + file.totalLines, 0),
      coveragePercent: 100,
      files,
    },
    summary: summarizeJourneys(journeys),
    journeys,
    limitations: [
      "A potentially external journey is not proof of a distinct human visitor.",
      "A 402 challenge without a validated request is not counted as purchase intent.",
      "Psychological or commercial motives cannot be inferred without explicit feedback.",
      "Valid JSON records without a parseable timestamp are covered by validation counts but excluded from the time window.",
    ],
  };
}

function helpText() {
  return `Usage: node scripts/analyze-railway-ndjson.mjs [options] <file...>\n\nOptions:\n  --since <ISO-8601>       Analyze events at or after this timestamp\n  --session-minutes <n>    Temporal grouping window (default: 15)\n  --out <path>             Write the JSON report to a file\n  --pretty                 Pretty-print JSON\n  --help                   Show this help\n`;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      since: { type: "string" },
      "session-minutes": { type: "string", default: "15" },
      out: { type: "string" },
      pretty: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(helpText());
    return;
  }
  if (positionals.length === 0) throw new Error("No NDJSON files supplied. Use --help for usage.");
  const sessionMinutes = Number.parseInt(values["session-minutes"], 10);
  if (!Number.isInteger(sessionMinutes) || sessionMinutes < 1) throw new Error("--session-minutes must be a positive integer.");

  const report = await analyzeFiles(positionals, { since: values.since, sessionMinutes });
  const json = `${JSON.stringify(report, null, values.pretty ? 2 : 0)}\n`;
  if (values.out) await writeFile(values.out, json, "utf8");
  else process.stdout.write(json);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`railway-log-analyzer: ${error.message}\n`);
    process.exitCode = 1;
  });
}
