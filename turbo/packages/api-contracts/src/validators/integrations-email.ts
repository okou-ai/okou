import { number, object, string, uuid } from "zod";

export const emailConnectBodySchema = object({
  messageId: uuid(),
  expires: number().int().positive(),
  signature: string().regex(/^[a-f0-9]{64}$/u),
});
