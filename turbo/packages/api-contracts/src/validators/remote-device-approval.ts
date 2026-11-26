import { object, string, uuid } from "zod";

export const remoteDeviceApprovalSchema = object({
  deviceId: uuid(),
  actionId: uuid(),
  reason: string().trim().min(1).max(500),
});
