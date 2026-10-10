import {
  USER_PREFERENCES_UNINITIALIZED,
  userLocaleSchema,
  userPreferencesContract,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { DEFAULT_USER_TIMEZONE, isValidTimeZone } from "@okouai/core/timezone";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import { publishUserPreferenceChangedForUserSafely } from "../external/realtime";
import { synchronizeMorningBriefTimezone$ } from "../services/morning-brief-timezone.service";

import { badRequestMessage, conflict } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { initializeMemberMemory$ } from "../services/member-memory-initialization.service";
import {
  updateUserPreferences$,
  userPreferences,
} from "../services/user-data.service";

function isValidUserLocale(locale: string | null): locale is UserLocale {
  return locale !== null && userLocaleSchema.safeParse(locale).success;
}

const updateUserPreferencesBody$ = bodyResultOf(userPreferencesContract.update);

const getUserPreferencesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const preferences = await get(
    userPreferences({ orgId: auth.orgId, userId: auth.userId }),
  );
  if (
    preferences.timezone === null ||
    !isValidTimeZone(preferences.timezone) ||
    !isValidUserLocale(preferences.locale)
  ) {
    return {
      status: 409 as const,
      body: {
        error: {
          code: USER_PREFERENCES_UNINITIALIZED,
          message: "User preferences require timezone or locale initialization",
        },
      },
    };
  }
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
    if (body.data.cloudBrowserEnabledByDefault !== undefined) {
      await publishUserPreferenceChangedForUserSafely(auth.userId, [
        "cloudBrowserEnabledByDefault",
      ]);
    }
    if (body.data.timezone !== undefined) {
      const synchronized = await set(
        synchronizeMorningBriefTimezone$,
        {
          orgId: auth.orgId,
          member: { userId: auth.userId, role: auth.orgRole ?? "member" },
        },
        signal,
      );
      if (synchronized === "conflict") {
        // The preference is saved; the Morning Brief schedule lost a race and
        // is left unchanged. Repeating the same update re-applies it.
        return conflict(
          "Morning Brief schedule changed concurrently. Retry the time zone update.",
        );
      }
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
async function fillMissingUserPreferenceFields(
  db: Db,
  identity: { readonly orgId: string; readonly userId: string },
  existing:
    | Pick<typeof orgMembersMetadata.$inferSelect, "timezone" | "locale">
    | undefined,
  requested: { readonly timezone?: string; readonly locale: UserLocale },
): Promise<
  | {
      readonly kind: "unchanged";
      readonly timezone: string;
      readonly locale: UserLocale;
    }
  | { readonly kind: "invalid-timezone" }
  | { readonly kind: "written" }
> {
  const existingTimezone = existing?.timezone ?? null;
  const existingLocale = existing?.locale ?? null;
  if (
    existingTimezone !== null &&
    isValidTimeZone(existingTimezone) &&
    isValidUserLocale(existingLocale)
  ) {
    return {
      kind: "unchanged",
      timezone: existingTimezone,
      locale: existingLocale,
    };
  }
  const timezoneMissing =
    !existingTimezone || !isValidTimeZone(existingTimezone);
  const localeMissing = !isValidUserLocale(existingLocale);
  const timezone = requested.timezone ?? DEFAULT_USER_TIMEZONE;
  const locale = requested.locale;
  if (!isValidTimeZone(timezone)) {
    return { kind: "invalid-timezone" };
  }
  await db
    .insert(orgMembersMetadata)
    .values({
      ...identity,
      selectedModel: AUTO_SELECTED_MODEL,
      timezone: timezoneMissing ? timezone : existingTimezone,
      locale: localeMissing ? locale : existingLocale,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        ...(timezoneMissing && { timezone }),
        ...(localeMissing && { locale }),
      },
    });
  return { kind: "written" };
}

const initializeUserPreferencesInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(initializeUserPreferencesBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const identity = { orgId: auth.orgId, userId: auth.userId };
    const db = set(writeDb$);
    const [existing] = await db
      .select({
        timezone: orgMembersMetadata.timezone,
        locale: orgMembersMetadata.locale,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, identity.orgId),
          eq(orgMembersMetadata.userId, identity.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const writeOutcome = await fillMissingUserPreferenceFields(
      db,
      identity,
      existing,
      body.data,
    );
    signal.throwIfAborted();
    if (writeOutcome.kind === "invalid-timezone") {
      return badRequestMessage("Invalid timezone");
    }
    // Existing members without memory are initialized here on demand; this
    // only creates missing memory or an empty HEAD and never rewrites content.
    await set(initializeMemberMemory$, identity, signal);
    signal.throwIfAborted();
    if (writeOutcome.kind === "unchanged") {
      const current = await get(userPreferences(identity));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ...current,
          timezone: writeOutcome.timezone,
          locale: writeOutcome.locale,
        },
      };
    }
    const [stored] = await db
      .select({
        timezone: orgMembersMetadata.timezone,
        locale: orgMembersMetadata.locale,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, identity.orgId),
          eq(orgMembersMetadata.userId, identity.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const preferences = await get(userPreferences(identity));
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        ...preferences,
        timezone: stored?.timezone ?? null,
        locale: stored?.locale ?? null,
      },
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
