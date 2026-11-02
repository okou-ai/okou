import { object, string } from "zod";

export const sshChangedPayloadSchema = object({
  orgId: string().min(1),
}).strict();
