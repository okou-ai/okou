import * as z from "zod";

export const remoteHostIdentitySchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.string().datetime(),
  generation: z.int().positive().max(2_147_483_647),
});
