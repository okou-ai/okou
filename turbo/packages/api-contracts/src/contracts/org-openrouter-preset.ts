import { object, strictObject, string, type infer as zInfer } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { orgOpenrouterPresetSchema } from "../validators/org-openrouter-preset";
export {
  ORG_OPENROUTER_PRESETS,
  orgOpenrouterPresetSchema,
} from "../validators/org-openrouter-preset";

export type OrgOpenrouterPreset = zInfer<typeof orgOpenrouterPresetSchema>;

// Existing operator-configured values remain readable, even outside the UI allowlist.
const responseSchema = object({ openrouterPreset: string().nullable() });
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
    body: strictObject({
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
