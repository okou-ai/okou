import {
  array,
  boolean,
  int,
  iso,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
} from "zod";
import { userPermissionGrantBatchItemSchema } from "../validators/user-permission-grants";

export const hostAuthorizationPermissionsSchema = array(
  userPermissionGrantBatchItemSchema,
).max(20);
export const hostAuthorizationSchema = object({
  id: uuid(),
  chatThreadId: uuid(),
  connectionId: uuid(),
  requestedByRunId: uuid(),
  displayName: string(),
  host: string(),
  port: int(),
  reason: string(),
  status: zEnum([
    "pending",
    "approved",
    "denied",
    "expired",
    "revoked",
    "stale",
  ]),
  requestExpiresAt: iso.datetime(),
  enabled: boolean(),
  continuationPending: boolean(),
  approvalBlockedReason: zEnum([
    "run_active",
    "run_unavailable",
    "chat_busy",
    "host_changed",
    "permissions_required",
    "ssh_access_required",
  ]).nullable(),
  requiredPermissions: hostAuthorizationPermissionsSchema,
  authorizationUrl: url(),
});
