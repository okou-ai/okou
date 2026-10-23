import * as z from "zod";

/**
 * Secret type schema
 */
export const secretTypeSchema = z.enum(["user", "model-provider", "connector"]);

export type SecretType = z.infer<typeof secretTypeSchema>;

/**
 * Secret metadata response (value is never returned)
 */
export const secretResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  type: secretTypeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SecretResponse = z.infer<typeof secretResponseSchema>;
