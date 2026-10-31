import { literal, object, string, url, type infer as zInfer } from "zod";

export const teamsFileTokenPayloadSchema = object({
  tenantId: string().min(1),
  url: url(),
  downloadMode: literal("graph").optional(),
  downloadInfo: literal(true).optional(),
  id: string().min(1).optional(),
  name: string().min(1).optional(),
  contentType: string().min(1).optional(),
});

export type TeamsFileTokenPayload = zInfer<typeof teamsFileTokenPayloadSchema>;
