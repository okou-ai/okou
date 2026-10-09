import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const ORG_OPENROUTER_PRESETS = [
  "@preset/okou-1-0",
  "@preset/okou-1-0-dsf",
  "@preset/okou-experimental",
  "@preset/memory",
] as const;

export const orgOpenrouterPresetSchema = z.enum(ORG_OPENROUTER_PRESETS);
export type OrgOpenrouterPreset = z.infer<typeof orgOpenrouterPresetSchema>;

// Existing operator-configured values remain readable, even outside the UI allowlist.
const responseSchema = z.object({ openrouterPreset: z.string().nullable() });
const c = initContract();

export const orgOpenrouterPresetContract = c.router({
  get: {
    method: "GET",
    path: "/api/org/openrouter-preset",
    headers: authHeadersSchema,
    responses: {
      200: responseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Get the organization's OpenRouter preset (Debug administrators only)",
  },
  update: {
    method: "PUT",
    path: "/api/org/openrouter-preset",
    headers: authHeadersSchema,
    body: z.strictObject({
      openrouterPreset: orgOpenrouterPresetSchema.nullable(),
    }),
    responses: {
      200: responseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Update the organization's OpenRouter preset (Debug administrators only)",
  },
});
