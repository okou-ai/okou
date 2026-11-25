import { command, computed, type Computed } from "ccstate";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { initializeMemberMemory$ } from "./member-memory-initialization.service";
import type {
  OnboardingStatusResponse,
  OnboardingIndustry,
} from "@okouai/api-contracts/contracts/onboarding";
import { isValidTimeZone } from "@okouai/core/timezone";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { AuthContext } from "../../types/auth";
import { logger } from "../../lib/log";
import type { ClerkUser } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import type { WorkflowMember } from "./workflow-data.service";
import { markOrgOnboardingComplete$ } from "./onboarding-completion.command";
import { shouldEnableOnboardingSuggestions$ } from "./onboarding-suggestions.service";
import { ensureProactiveWorkflows$ } from "./proactive-workflows-lifecycle.service";

const L = logger("onboarding.service");

type CompleteOnboardingResponse = {
  readonly status: 200;
  readonly body: {
    readonly onboardingComplete: true;
    readonly needsOnboarding: false;
  };
};

/**
 * A member's completion is theirs alone: it stamps their own membership row and
 * never touches the organization's onboarding state or provisioning, which
 * stay with the admin who set the workspace up.
 */
const markMemberOnboardingComplete$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly enableSuggestions: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const { orgId, userId } = args;
    signal.throwIfAborted();
    const completedAt = nowDate();
    const rows = await db
      .insert(orgMembersMetadata)
      .values({
        orgId,
        userId,
        selectedModel: AUTO_SELECTED_MODEL,
        onboardingCompletedAt: completedAt,
        proactiveSuggestionsEnabled: args.enableSuggestions ? true : undefined,
        createdAt: completedAt,
        updatedAt: completedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: {
          onboardingCompletedAt: sql`coalesce(${orgMembersMetadata.onboardingCompletedAt}, excluded.onboarding_completed_at)`,
          ...(args.enableSuggestions && {
            proactiveSuggestionsEnabled: sql`coalesce(${orgMembersMetadata.proactiveSuggestionsEnabled}, true)`,
          }),
          updatedAt: completedAt,
        },
        setWhere: or(
          isNull(orgMembersMetadata.onboardingCompletedAt),
          args.enableSuggestions
            ? isNull(orgMembersMetadata.proactiveSuggestionsEnabled)
            : undefined,
        ),
      })
      .returning({ userId: orgMembersMetadata.userId });
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

type TimezoneFallbackOutcome = "missing" | "invalid" | "stored" | "preserved";

const preserveOrStoreTimezoneFallback$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly timezone?: string;
    },
    signal: AbortSignal,
  ): Promise<TimezoneFallbackOutcome> => {
    if (args.timezone === undefined) {
      return "missing";
    }
    if (!isValidTimeZone(args.timezone)) {
      return "invalid";
    }

    const db = set(writeDb$);
    signal.throwIfAborted();
    const updatedAt = nowDate();
    const rows = await db
      .insert(orgMembersMetadata)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        selectedModel: AUTO_SELECTED_MODEL,
        timezone: args.timezone,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: { timezone: args.timezone, updatedAt },
        setWhere: isNull(orgMembersMetadata.timezone),
      })
      .returning({ timezone: orgMembersMetadata.timezone });
    signal.throwIfAborted();
    return rows.length > 0 ? "stored" : "preserved";
  },
);

interface CompleteOnboardingArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly isAdmin: boolean;
  readonly clerkUser?: ClerkUser;
  readonly timezone?: string;
  readonly industry?: OnboardingIndustry;
}

function onboardingComplete(orgId: string): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const db = get(db$);
    const [row] = await db
      .select({ onboardingComplete: orgMetadata.onboardingComplete })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return row?.onboardingComplete ?? false;
  });
}

/**
 * Whether a non-admin member still has the source-first onboarding ahead of
 * them. It is personal.
 *
 * A member who has completed their flow or owns any chat thread in this org
 * is treated as onboarded. Thread origin does not change this eligibility.
 */
function memberNeedsOnboarding(
  orgId: string,
  userId: string,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const db = get(db$);
    const [completion] = await db
      .select({ completedAt: orgMembersMetadata.onboardingCompletedAt })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);
    if (completion?.completedAt) {
      return false;
    }

    const [usage] = await db
      .select({ threadId: chatThreads.id })
      .from(chatThreads)
      .where(and(eq(chatThreads.userId, userId), eq(chatThreads.orgId, orgId)))
      .limit(1);
    return usage === undefined;
  });
}

export function needsOnboarding(
  auth: AuthContext & { readonly orgId: string },
): Computed<Promise<boolean>> {
  const { orgId, userId, orgRole } = auth;
  return orgRole === "admin"
    ? computed(async (get) => {
        return !(await get(onboardingComplete(orgId)));
      })
    : memberNeedsOnboarding(orgId, userId);
}

export function memberOnboardingStatus(
  auth: AuthContext,
): Computed<Promise<OnboardingStatusResponse>> {
  return computed(async (get): Promise<OnboardingStatusResponse> => {
    if (!auth.orgId) {
      const isAdmin = false;
      const complete = false;
      return {
        needsOnboarding: isAdmin && !complete,
        onboardingComplete: complete,
        isAdmin,
        hasOrg: false,
      };
    }

    const isAdmin = "orgRole" in auth && auth.orgRole === "admin";
    const complete = await get(onboardingComplete(auth.orgId));
    // `onboardingComplete` stays the organization's answer for everyone; only
    // `needsOnboarding` is personal for a member.
    const needsOnboarding = isAdmin
      ? !complete
      : await get(memberNeedsOnboarding(auth.orgId, auth.userId));

    return {
      needsOnboarding,
      onboardingComplete: complete,
      isAdmin,
      hasOrg: true,
    };
  });
}

export const completeOnboarding$ = command(
  async (
    { set },
    args: CompleteOnboardingArgs,
    signal: AbortSignal,
  ): Promise<CompleteOnboardingResponse> => {
    const owner = { orgId: args.orgId, userId: args.member.userId };
    await set(initializeMemberMemory$, owner, signal);
    signal.throwIfAborted();
    // Resolve the registration cohort before stamping completion so a failed
    // Clerk lookup can be retried while onboarding is still pending.
    const enableSuggestions = await set(
      shouldEnableOnboardingSuggestions$,
      owner,
      args.clerkUser,
      signal,
    );
    signal.throwIfAborted();
    const updated = args.isAdmin
      ? await set(
          markOrgOnboardingComplete$,
          { ...owner, industry: args.industry, enableSuggestions },
          signal,
        )
      : await set(
          markMemberOnboardingComplete$,
          { ...owner, enableSuggestions },
          signal,
        );
    signal.throwIfAborted();
    const timezone = await settle(
      set(
        preserveOrStoreTimezoneFallback$,
        { ...owner, timezone: args.timezone },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (timezone.ok) {
      L.debug("Member onboarding completed", {
        ...owner,
        updated,
        timezone: timezone.value,
      });
    } else {
      L.warn("Member onboarding timezone fallback failed", {
        ...owner,
        updated,
        error: timezone.error,
      });
    }
    if (enableSuggestions) {
      // The saved preference also makes the owner eligible for scheduled reconciliation.
      const setup = await settle(
        set(ensureProactiveWorkflows$, owner, signal),
        signal,
      );
      if (!setup.ok) {
        L.warn("Could not prepare Suggestions after onboarding", {
          ...owner,
          error: setup.error,
        });
      }
    }
    return {
      status: 200,
      body: {
        onboardingComplete: true,
        needsOnboarding: false,
      },
    };
  },
);
