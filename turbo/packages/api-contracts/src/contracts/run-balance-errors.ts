import { modelProviderTypeSchema } from "./model-providers";
import type { RunFailureReasonToken } from "./run-failure-reasons";
import { z } from "zod";

export const PROVIDER_INSUFFICIENT_CREDITS_MESSAGE =
  "Your connected model provider account has insufficient balance.";
export const MODEL_UNAVAILABLE_MESSAGE = "The current model is unavailable.";

const providerErrorSchema = z.object({
  type: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
});
const providerErrorBodySchema = z.union([
  z.object({ error: providerErrorSchema }).transform((body) => {
    return body.error;
  }),
  z
    .object({
      type: z.literal("response.failed"),
      response: z.object({ error: providerErrorSchema }),
    })
    .transform((body) => {
      return body.response.error;
    }),
  providerErrorSchema.extend({ type: z.literal("error") }),
  z
    .object({
      choices: z
        .tuple([z.object({ error: providerErrorSchema })])
        .rest(z.unknown()),
    })
    .transform((body) => {
      return body.choices[0].error;
    }),
]);
const BILLING_CODES = new Set([
  "billing",
  "billing_error",
  "insufficient_quota",
  "payment_required",
]);

/** A provider error object, never a local vm0 `error: "insufficient_credits"` envelope. */
export function isProviderBalanceErrorBody(body: unknown): boolean {
  const parsed = providerErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return false;
  }
  const error = parsed.data;
  return (
    BILLING_CODES.has(String(error.code).toLowerCase()) ||
    BILLING_CODES.has(error.type?.toLowerCase() ?? "") ||
    error.code === 402 ||
    (error.type === "invalid_request_error" &&
      error.message?.startsWith(
        "Your credit balance is too low to access the Anthropic API.",
      ) === true)
  );
}

/** Legacy terminal error presentation only; raw text is not diagnostic provenance. */
export function isLegacyProviderBalanceError(
  message: string,
  framework: string | null | undefined,
): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    (framework === "claude-code" &&
      normalized === "credit balance is too low") ||
    (normalized.startsWith("api error: 402 ") &&
      normalized.includes("requires more credits") &&
      normalized.includes("can only afford")) ||
    isProviderBalanceResponseError(message)
  );
}

function isProviderBalanceResponseError(message: string): boolean {
  if (
    !/^(?:api error: \d{3} |unexpected status \d{3} [^:]+:)/i.test(
      message.trim(),
    )
  ) {
    return false;
  }
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start < 0 || end < start) {
    return false;
  }
  try {
    return isProviderBalanceErrorBody(
      JSON.parse(message.slice(start, end + 1)) as unknown,
    );
  } catch {
    return false;
  }
}

export function publicProviderBalanceFailureReason(
  modelProvider: string | null | undefined,
): "provider_insufficient_credits" | "model_unavailable" {
  const provider = modelProviderTypeSchema.safeParse(modelProvider);
  return provider.success && provider.data !== "built-in"
    ? "provider_insufficient_credits"
    : "model_unavailable";
}

/** Keep explicit vm0 credit failures independent of the run's credential owner. */
export function formatRunBalanceError(params: {
  readonly failureReason?: RunFailureReasonToken | null;
  readonly message: string;
  readonly modelProvider?: string | null;
  readonly framework?: string | null;
}): string | undefined {
  if (params.failureReason === "model_unavailable") {
    return MODEL_UNAVAILABLE_MESSAGE;
  }
  if (
    params.failureReason === "provider_insufficient_credits" ||
    ((params.failureReason == null ||
      params.failureReason === "insufficient_credits") &&
      isLegacyProviderBalanceError(
        params.message,
        params.modelProvider === "built-in" ? "claude-code" : params.framework,
      ))
  ) {
    return publicProviderBalanceFailureReason(params.modelProvider) ===
      "provider_insufficient_credits"
      ? PROVIDER_INSUFFICIENT_CREDITS_MESSAGE
      : MODEL_UNAVAILABLE_MESSAGE;
  }
  return undefined;
}
