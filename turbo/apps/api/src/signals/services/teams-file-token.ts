import { z } from "zod";

export const teamsFileTokenPayloadSchema = z.object({
  tenantId: z.string().min(1),
  url: z.string().url(),
  downloadMode: z.literal("graph").optional(),
  downloadInfo: z.literal(true).optional(),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  contentType: z.string().min(1).optional(),
});

export type TeamsFileTokenPayload = z.infer<typeof teamsFileTokenPayloadSchema>;
