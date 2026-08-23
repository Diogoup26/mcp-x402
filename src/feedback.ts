import * as z from "zod/v4";

export const JOURNEY_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const FEEDBACK_REASONS = [
  "research_only",
  "no_wallet",
  "unsupported_network",
  "insufficient_funds",
  "spending_not_authorized",
  "price",
  "insufficient_value",
  "integration_error",
  "other",
] as const;

export const FEEDBACK_STAGES = [
  "discovery",
  "preflight",
  "payment",
  "execution",
  "delivery",
] as const;

export const FEEDBACK_INTENTS = [
  "research",
  "analyze_page",
  "verify_conditions",
  "general_question",
  "evaluate_service",
  "other",
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export type FeedbackStage = (typeof FEEDBACK_STAGES)[number];
export type FeedbackIntent = (typeof FEEDBACK_INTENTS)[number];

export const conversionFeedbackInput = z.object({
  journeyId: z.string().regex(JOURNEY_ID_PATTERN),
  reason: z.enum(FEEDBACK_REASONS),
  stage: z.enum(FEEDBACK_STAGES).optional(),
  intent: z.enum(FEEDBACK_INTENTS).optional(),
  automatic: z.boolean().optional(),
}).strict();

export type FeedbackOptions = {
  reason?: FeedbackReason;
  stage?: FeedbackStage;
  intent?: FeedbackIntent;
};

type FeedbackRequest = {
  serviceOrigin: string;
  journeyId: string;
  userAgent: string;
  reason: FeedbackReason;
  stage?: FeedbackStage | undefined;
  intent?: FeedbackIntent | undefined;
  automatic?: boolean | undefined;
};

function isAllowed<T extends readonly string[]>(
  values: T,
  value: string,
): value is T[number] {
  return values.includes(value as T[number]);
}

function readOption(
  args: string[],
  index: number,
  name: string,
): { value: string; consumed: number } | null {
  const argument = args[index];
  if (!argument) return null;
  if (argument === name) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`A opção ${name} requer um valor.`);
    }
    return { value, consumed: 2 };
  }

  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (!value) {
      throw new Error(`A opção ${name} requer um valor.`);
    }
    return { value, consumed: 1 };
  }

  return null;
}

export function parseFeedbackOptions(args: string[]): {
  positional: string[];
  feedback: FeedbackOptions;
} {
  const positional: string[] = [];
  const feedback: FeedbackOptions = {};

  for (let index = 0; index < args.length;) {
    const reason = readOption(args, index, "--feedback-reason");
    if (reason) {
      if (!isAllowed(FEEDBACK_REASONS, reason.value)) {
        throw new Error(
          `Motivo de feedback inválido. Use: ${FEEDBACK_REASONS.join(", ")}.`,
        );
      }
      feedback.reason = reason.value;
      index += reason.consumed;
      continue;
    }

    const stage = readOption(args, index, "--feedback-stage");
    if (stage) {
      if (!isAllowed(FEEDBACK_STAGES, stage.value)) {
        throw new Error(
          `Etapa de feedback inválida. Use: ${FEEDBACK_STAGES.join(", ")}.`,
        );
      }
      feedback.stage = stage.value;
      index += stage.consumed;
      continue;
    }

    const intent = readOption(args, index, "--feedback-intent");
    if (intent) {
      if (!isAllowed(FEEDBACK_INTENTS, intent.value)) {
        throw new Error(
          `Intenção de feedback inválida. Use: ${FEEDBACK_INTENTS.join(", ")}.`,
        );
      }
      feedback.intent = intent.value;
      index += intent.consumed;
      continue;
    }

    positional.push(args[index]!);
    index += 1;
  }

  if ((feedback.stage || feedback.intent) && !feedback.reason) {
    throw new Error(
      "--feedback-stage e --feedback-intent requerem --feedback-reason.",
    );
  }

  return { positional, feedback };
}

export function getEffectiveFeedbackStage(
  feedback: FeedbackOptions,
): FeedbackStage | undefined {
  if (!feedback.reason) return undefined;
  return feedback.stage ?? "payment";
}

export function shouldStopBeforePayment(feedback: FeedbackOptions): boolean {
  const stage = getEffectiveFeedbackStage(feedback);
  return stage === "discovery" || stage === "preflight" || stage === "payment";
}

export async function sendFeedback(input: FeedbackRequest): Promise<void> {
  const response = await fetch(`${input.serviceOrigin}/feedback`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": input.userAgent,
      "x-journey-id": input.journeyId,
    },
    body: JSON.stringify({
      journeyId: input.journeyId,
      reason: input.reason,
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.intent ? { intent: input.intent } : {}),
      ...(input.automatic ? { automatic: true } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const result = await response.json().catch(() => null) as {
    accepted?: unknown;
  } | null;
  if (response.status !== 202 || result?.accepted !== true) {
    throw new Error(`Feedback recusado com HTTP ${response.status}.`);
  }
}

export async function trySendAutomaticIntegrationFeedback(input: {
  serviceOrigin: string;
  journeyId: string;
  userAgent: string;
  stage: FeedbackStage;
  intent?: FeedbackIntent;
}): Promise<boolean> {
  try {
    await sendFeedback({
      ...input,
      reason: "integration_error",
      automatic: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function getFeedbackHint(): string {
  return [
    "Feedback opcional sem texto livre:",
    `--feedback-reason <${FEEDBACK_REASONS.join("|")}>`,
    `--feedback-stage <${FEEDBACK_STAGES.join("|")}>`,
    `--feedback-intent <${FEEDBACK_INTENTS.join("|")}>`,
    "Sem --feedback-stage, o feedback explícito é enviado na etapa payment e o comprador não autoriza pagamento.",
  ].join(" ");
}
