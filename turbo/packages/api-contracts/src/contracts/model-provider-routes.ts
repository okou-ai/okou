import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
const c = initContract();

const builtInModelCooldownIdentitySchema = z.object({
  selectedModel: z.string(),
  providerType: z.string(),
  upstreamModel: z.string(),
});

export const builtInModelCooldownDiagnosticsSchema = z.object({
  canCancelCooldowns: z.boolean().optional(),
  activeCooldowns: z.array(
    builtInModelCooldownIdentitySchema.extend({
      unavailableUntil: z.iso.datetime(),
    }),
  ),
});

export type BuiltInModelCooldownDiagnostics = z.infer<
  typeof builtInModelCooldownDiagnosticsSchema
>;

export const modelProviderCooldownDiagnosticsContract = c.router({
  get: {
    method: "GET",
    path: "/api/model-providers/cooldown-diagnostics",
    headers: authHeadersSchema,
    responses: {
      200: builtInModelCooldownDiagnosticsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get built-in model cooldown diagnostics",
  },
  cancel: {
    method: "DELETE",
    path: "/api/model-providers/cooldown-diagnostics",
    headers: authHeadersSchema,
    body: builtInModelCooldownIdentitySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Cancel a built-in model cooldown (staff only)",
  },
});

export type ModelProviderCooldownDiagnosticsContract =
  typeof modelProviderCooldownDiagnosticsContract;

