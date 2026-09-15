import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { isValidTimeZone } from "@okouai/core/timezone";
import { and, eq, isNull } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { publishMorningBriefChangedSafely } from "../external/realtime";
import { command, computed } from "ccstate";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";

import { badRequestMessage } from "../../lib/error";
import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import {
  ensureMorningBriefDefaultEnabled$,
  synchronizeMorningBriefTimezone$,
  type EnsureMorningBriefDefaultEnabledResult,
} from "../services/morning-brief-preference.service";
import {
  updateUserPreferences$,
  userPreferences,
} from "../services/user-data.service";
import { settle, tapError } from "../utils";

const L = logger("user-preferences");

const updateUserPreferencesBody$ = bodyResultOf(userPreferencesContract.update);

async function observeMorningBriefProvisioning(
  task: Promise<EnsureMorningBriefDefaultEnabledResult>,
  context: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  const provisioning = await task;
  const details = { ...context, provisioning };
  if (provisioning.outcome === "failed") {
    L.warn("Morning Brief timezone provisioning outcome", details);
    return;
  }
  L.info("Morning Brief timezone provisioning outcome", details);
}

function enqueueMorningBriefProvisioning(
  task: Promise<EnsureMorningBriefDefaultEnabledResult>,
  context: { readonly orgId: string; readonly userId: string },
): void {
  waitUntil(
    tapError(observeMorningBriefProvisioning(task, context), (error) => {
      L.error("Morning Brief timezone provisioning failed", {
        ...context,
        error,
      });
    }),
  );
}

const getUserPreferencesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const preferences = await get(
    userPreferences({ orgId: auth.orgId, userId: auth.userId }),
  );
  return {
    status: 200 as const,
    body: preferences,
  };
});

const updateUserPreferencesInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(updateUserPreferencesBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      updateUserPreferences$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        preferences: body.data,
      },
      signal,
    );
    if (!result.ok) {
      return badRequestMessage(result.message);
    }
    if (body.data.timezone !== undefined) {
      await set(
        synchronizeMorningBriefTimezone$,
        {
          orgId: auth.orgId,
          member: { userId: auth.userId, role: auth.orgRole ?? "member" },
        },
        signal,
      );
      enqueueMorningBriefProvisioning(
        set(
          ensureMorningBriefDefaultEnabled$,
          {
            orgId: auth.orgId,
            member: {
              userId: auth.userId,
              role: auth.orgRole ?? "member",
            },
          },
          signal,
        ),
        { orgId: auth.orgId, userId: auth.userId },
      );
    }
    return {
      status: 200 as const,
      body: result.data,
    };
  },
);

const initializeUserPreferencesBody$ = bodyResultOf(
  userPreferencesContract.initialize,
);
const initializeUserPreferencesInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(initializeUserPreferencesBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const timezone = body.data.timezone;
    if (timezone !== undefined && !isValidTimeZone(timezone)) {
      return badRequestMessage("Invalid timezone");
    }
    const db = set(writeDb$);
    if (timezone !== undefined) {
      await db
        .insert(orgMembersMetadata)
        .values({ orgId: auth.orgId, userId: auth.userId, timezone })
        .onConflictDoUpdate({
          target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
          set: { timezone },
          setWhere: isNull(orgMembersMetadata.timezone),
        });
    }
    signal.throwIfAborted();
    // The enrollment is durable before external reads. A dependency outage must
    // not fail timezone setup; the cron worker owns recovery after this attempt.
    const enrollment = await settle(
      set(
        ensureMorningBriefDefaultEnabled$,
        {
          orgId: auth.orgId,
          member: { userId: auth.userId, role: auth.orgRole ?? "member" },
        },
        signal,
      ),
      signal,
    );
    const details = {
      orgId: auth.orgId,
      userId: auth.userId,
      outcome: enrollment.ok ? enrollment.value : "failed",
      ...(!enrollment.ok ? { error: enrollment.error } : {}),
    };
    if (!enrollment.ok || enrollment.value.outcome === "failed") {
      L.warn("Morning Brief initialization deferred", details);
    } else {
      L.info("Morning Brief initialization outcome", details);
    }
    await publishMorningBriefChangedSafely({
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    const [preferences] = await db
      .select({ timezone: orgMembersMetadata.timezone })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, auth.orgId),
          eq(orgMembersMetadata.userId, auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const current = await get(
      userPreferences({ orgId: auth.orgId, userId: auth.userId }),
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { ...current, timezone: preferences?.timezone ?? null },
    };
  },
);

export const userPreferencesRoutes: readonly RouteEntry[] = [
  {
    route: userPreferencesContract.initialize,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      initializeUserPreferencesInner$,
    ),
  },
  {
    route: userPreferencesContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUserPreferencesInner$,
    ),
  },
  {
    route: userPreferencesContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateUserPreferencesInner$,
    ),
  },
];
