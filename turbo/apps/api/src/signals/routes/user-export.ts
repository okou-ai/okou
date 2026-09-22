import { command, computed } from "ccstate";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import { logger } from "../../lib/log";
import {
  startUserExport$,
  toUserExportStartResponse,
  userExportStatus,
} from "../services/user-export.service";
import { executeDurableUserExportWork$ } from "../services/user-export-durable.service";
import { tapError } from "../utils";

const log = logger("route:user-export");

const getUserExportInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const body = await get(userExportStatus(auth.userId));

  return { status: 200 as const, body };
});

const postUserExportInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    signal.throwIfAborted();

    const result = await set(
      startUserExport$,
      { userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "rate_limited") {
      return {
        status: 429 as const,
        body: {
          error: {
            code: "RATE_LIMITED",
            message: "Export already completed within the last 24 hours",
          },
        },
      };
    }

    if (result.shouldExecute) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          set(
            executeDurableUserExportWork$,
            { jobId: result.jobId, maxSteps: 10 },
            backgroundSignal,
          ),
          (error) => {
            log.error("executeDurableUserExportWork failed", {
              jobId: result.jobId,
              error,
            });
          },
        ),
      );
    }

    return {
      status: 202 as const,
      body: toUserExportStartResponse(result),
    };
  },
);

export const userExportRoutes: readonly RouteEntry[] = [
  {
    route: userExportContract.get,
    handler: authRoute({}, getUserExportInner$),
  },
  {
    route: userExportContract.post,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      postUserExportInner$,
    ),
  },
];
