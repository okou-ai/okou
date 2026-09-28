import { sshHostsContract } from "@okouai/api-contracts/contracts/ssh-access";
import { command } from "ccstate";

import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { sshErrorResponse } from "../../lib/ssh-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { listRunSshHosts } from "../services/ssh-access.service";

const unavailable = Object.freeze(
  sshErrorResponse(
    404,
    SSH_ERROR_CODES.UNAVAILABLE,
    "SSH access is not available",
  ),
);

const listHosts$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("SSH inventory requires Agent authentication");
  }
  const result = await listRunSshHosts(get(db$), auth, signal);
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : unavailable;
});

export const sshAccessRoutes: readonly RouteEntry[] = [
  {
    route: sshHostsContract.list,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "ssh:read",
      },
      listHosts$,
    ),
  },
];
