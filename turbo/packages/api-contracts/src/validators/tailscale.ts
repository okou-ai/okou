import { array, int, object, string, uuid, enum as zEnum } from "zod";

export const tailscaleChangedPayloadSchema = object({
  orgId: string().min(1),
}).strict();
export const TAILSCALE_CREDENTIAL_MAX_LENGTH = 4_096;
const credentialValue = string()
  .min(1)
  .max(TAILSCALE_CREDENTIAL_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/u);
export const tailscaleCredentialsSchema = object({
  clientId: credentialValue,
  clientSecret: credentialValue,
}).strict();
export const tailscaleTagsSchema = array(
  string().regex(/^tag:[a-z][a-z0-9-]{0,62}$/u),
)
  .min(1)
  .max(16)
  .refine(
    (tags) => {
      return new Set(tags).size === tags.length;
    },
    {
      message: "Tags must be unique",
    },
  );
export const name = string().trim().min(1).max(128);
export const createTailscaleRequestSchema = object({
  name,
  credentials: tailscaleCredentialsSchema,
  tags: tailscaleTagsSchema,
}).strict();
export const createTailscaleConfigRequestSchema =
  createTailscaleRequestSchema.extend({
    id: uuid(),
    scope: zEnum(["personal", "organization"]).optional(),
  });
export const revision = int().positive().max(2_147_483_647);
export const updateTailscaleConfigRequestSchema = object({
  expectedRevision: revision,
  name: name.optional(),
  credentials: tailscaleCredentialsSchema.optional(),
  tags: tailscaleTagsSchema.optional(),
})
  .strict()
  .refine(
    (body) => {
      return (
        body.name !== undefined ||
        body.credentials !== undefined ||
        body.tags !== undefined
      );
    },
    { message: "At least one Tailscale field must be updated" },
  );
