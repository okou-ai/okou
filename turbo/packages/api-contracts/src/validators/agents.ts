import { boolean, object, string, enum as zEnum } from "zod";

export const agentVisibilitySchema = zEnum(["public", "private"]);

/** Agent metadata shared by HTTP contracts and independent validators. */
export const agentResponseSchema = object({
  agentId: string(),
  isDefaultAgent: boolean(),
  ownerId: string(),
  description: string().nullable(),
  displayName: string().nullable(),
  sound: string().nullable(),
  avatarUrl: string().nullable(),
  visibility: agentVisibilitySchema,
});
