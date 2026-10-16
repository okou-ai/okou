import { z } from "zod";

export const remoteHostIdentitySchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.string().datetime(),
  generation: z.int().positive().max(2_147_483_647),
});

export const remoteInventoryDiagnosticsSchema = z.strictObject({
  version: z.literal(1),
  identities: z.array(remoteHostIdentitySchema),
});

export const remoteHostInventoryQuerySchema = z
  .strictObject({ diagnostics: z.literal("1").optional() })
  .optional();
