import { object, string, uuid, enum as zEnum, type infer as zInfer } from "zod";

/**
 * Secret type schema
 */
export const secretTypeSchema = zEnum(["user", "model-provider", "connector"]);

export type SecretType = zInfer<typeof secretTypeSchema>;

/**
 * Secret metadata response (value is never returned)
 */
export const secretResponseSchema = object({
  id: uuid(),
  name: string(),
  description: string().nullable(),
  type: secretTypeSchema,
  createdAt: string(),
  updatedAt: string(),
});

export type SecretResponse = zInfer<typeof secretResponseSchema>;
