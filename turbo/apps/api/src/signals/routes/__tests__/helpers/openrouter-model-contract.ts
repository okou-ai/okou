import { HttpResponse } from "msw";
import { z } from "zod";

const modelRequestSchema = z.object({
  model: z.string(),
  reasoning: z
    .union([
      z.object({ effort: z.string() }),
      z.object({ enabled: z.boolean() }),
    ])
    .optional(),
});

function unsupportedEffort(): Response {
  return HttpResponse.json(
    { error: { code: "unsupported_value", param: "reasoning.effort" } },
    { status: 400 },
  );
}

/**
 * Exact-model capability snapshots from https://openrouter.ai/api/v1/models.
 * `google/gemini-3.8-flash`, checked 2026-09-08: mandatory=true,
 * supported_efforts=[high, medium, low], default_effort=medium.
 * `xiaomi/mimo-v2.5`, checked 2026-09-21: mandatory=false with no
 * supported_efforts, so it exposes no effort selection at all and only the
 * on/off switch is meaningful. No catalog request is made by deterministic
 * tests.
 */
export function openRouterModelContractError(
  value: unknown,
): Response | undefined {
  const body = modelRequestSchema.parse(value);
  const reasoning = body.reasoning;
  if (reasoning === undefined || !("effort" in reasoning)) {
    return undefined;
  }
  if (
    body.model === "google/gemini-3.8-flash" &&
    !["high", "medium", "low"].includes(reasoning.effort)
  ) {
    return unsupportedEffort();
  }
  return body.model === "xiaomi/mimo-v2.5" ? unsupportedEffort() : undefined;
}
