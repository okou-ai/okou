import {
  morningBriefDebugTriggerContract,
  type MorningBriefDebugTriggerErrorCode,
} from "@okouai/api-contracts/contracts/morning-brief-debug-trigger";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { triggerMorningBriefNativeRun$ } from "../services/morning-brief-debug-trigger.service";
import type { MorningBriefBringForwardRefusal } from "../services/morning-brief-native-schedule.service";

/**
 * The owner-scoped on-demand trigger for the native Morning Brief.
 *
 * The owner is the authenticated caller and nothing in the request can name
 * another member, so a caller can only move their own obligation. The response
 * reports the obligation as queued: the ordinary per-minute cron claims it and
 * runs the real pipeline, which this route never invokes.
 */

interface RefusalResponse {
  readonly status: 409 | 429;
  readonly body: {
    readonly error: {
      readonly code: MorningBriefDebugTriggerErrorCode;
      readonly message: string;
    };
  };
}

function refused(
  status: 409 | 429,
  code: MorningBriefDebugTriggerErrorCode,
  message: string,
): RefusalResponse {
  return { status, body: { error: { code, message } } };
}

function refusalResponse(
  reason: MorningBriefBringForwardRefusal,
): RefusalResponse {
  switch (reason) {
    case "absent": {
      return refused(
        409,
        "MORNING_BRIEF_SCHEDULE_ABSENT",
        "This member has no native Morning Brief schedule.",
      );
    }
    case "not-native": {
      return refused(
        409,
        "MORNING_BRIEF_NOT_NATIVE",
        "This member's Morning Brief has not cut over to native yet.",
      );
    }
    case "disabled": {
      return refused(
        409,
        "MORNING_BRIEF_DISABLED",
        "This member's Morning Brief is disabled.",
      );
    }
    case "membership-generation": {
      return refused(
        409,
        "MORNING_BRIEF_MEMBERSHIP_CHANGED",
        "This member's organization membership changed. Retry later.",
      );
    }
    case "unsettled-occurrence": {
      return refused(
        409,
        "MORNING_BRIEF_RUN_IN_FLIGHT",
        "A Morning Brief run is already in flight for this member.",
      );
    }
    case "rate-limited": {
      return refused(
        429,
        "MORNING_BRIEF_TRIGGER_RATE_LIMITED",
        "A Morning Brief ran too recently. Retry later.",
      );
    }
  }
}

const trigger$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await set(
    triggerMorningBriefNativeRun$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "refused") {
    return refusalResponse(result.reason);
  }
  return {
    status: 200 as const,
    body: {
      status: "queued" as const,
      scheduledFor: result.scheduledFor.toISOString(),
    },
  };
});

export const morningBriefDebugTriggerRoutes: readonly RouteEntry[] = [
  {
    route: morningBriefDebugTriggerContract.trigger,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:write",
      },
      trigger$,
    ),
  },
];
