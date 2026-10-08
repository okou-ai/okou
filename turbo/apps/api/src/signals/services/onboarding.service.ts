import { command, computed, type Computed } from "ccstate";
import { initializeMemberMemory$ } from "./member-memory-initialization.service";
import type {
  OnboardingIndustry,
  OnboardingStatusResponse,
} from "@okouai/api-contracts/contracts/onboarding";
import { agentAvatarUrlForDefaultAgent } from "@okouai/core/agent-avatar";
import { agentDisplayName } from "@okouai/core/brand-presentation";
import { isValidTimeZone } from "@okouai/core/timezone";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, isNull, ne, or } from "drizzle-orm";

import type { AuthContext } from "../../types/auth";
import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import type { WorkflowMember } from "./workflow-data.service";
import { markOrgOnboardingComplete$ } from "./onboarding-completion.command";

const L = logger("onboarding.service");

interface DefaultAgentInfo {
  readonly composeId: string;
  readonly metadata: OnboardingStatusResponse["defaultAgentMetadata"];
}

type DefaultAgentMetadata = NonNullable<
  OnboardingStatusResponse["defaultAgentMetadata"]
>;

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
    args: { readonly orgId: string; readonly userId: string },
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
        onboardingCompletedAt: completedAt,
        createdAt: completedAt,
        updatedAt: completedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: { onboardingCompletedAt: completedAt, updatedAt: completedAt },
        setWhere: isNull(orgMembersMetadata.onboardingCompletedAt),
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
  readonly timezone?: string;
  readonly industry?: OnboardingIndustry;
}

function defaultAgentId(orgId: string): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return row?.defaultAgentId ?? null;
  });
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
 * Nobody who already uses the workspace is pulled into it: a member who has
 * started an ordinary chat in this org is treated as onboarded, just like one
 * who finished the flow. Morning Brief threads are delivered to a member
 * rather than started by them, so they do not count as use.
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
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(chatThreads.userId, userId),
          eq(agents.orgId, orgId),
          or(
            isNull(chatThreads.provenance),
            ne(chatThreads.provenance, "morning_brief"),
          ),
        ),
      )
      .limit(1);
    return usage === undefined;
  });
}

function defaultAgentInfo(
  orgId: string,
  composeId: string,
): Computed<Promise<DefaultAgentInfo | null>> {
  return computed(async (get): Promise<DefaultAgentInfo | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        displayName: agents.displayName,
        description: agents.description,
        sound: agents.sound,
        avatarUrl: agents.avatarUrl,
      })
      .from(agents)
      .where(and(eq(agents.id, composeId), eq(agents.orgId, orgId)))
      .limit(1);

    if (!row) {
      return null;
    }

    const metadata: DefaultAgentMetadata = {};
    if (row.displayName !== null) {
      metadata.displayName =
        agentDisplayName({
          agentId: composeId,
          defaultAgentId: composeId,
          displayName: row.displayName,
        }) ?? row.displayName;
    }
    if (row.description !== null) {
      metadata.description = row.description;
    }
    if (row.sound !== null) {
      metadata.sound = row.sound;
    }
    const avatarUrl = agentAvatarUrlForDefaultAgent({
      agentId: composeId,
      defaultAgentId: composeId,
      avatarUrl: row.avatarUrl,
    });
    if (avatarUrl !== null) {
      metadata.avatarUrl = avatarUrl;
    }

    return {
      composeId,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    };
  });
}

export function onboardingStatus(
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
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      };
    }

    const isAdmin = "orgRole" in auth && auth.orgRole === "admin";
    const agentId = await get(defaultAgentId(auth.orgId));
    const complete = await get(onboardingComplete(auth.orgId));
    const defaultAgent = agentId
      ? await get(defaultAgentInfo(auth.orgId, agentId))
      : null;
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
      hasDefaultAgent: defaultAgent !== null,
      defaultAgentId: defaultAgent?.composeId ?? null,
      defaultAgentMetadata: defaultAgent?.metadata ?? null,
    };
  });
}

const completeMemberOnboarding$ = command(
  async (
    { set },
    args: CompleteOnboardingArgs,
    signal: AbortSignal,
  ): Promise<CompleteOnboardingResponse> => {
    const firstCompletion = await set(
      markMemberOnboardingComplete$,
      { orgId: args.orgId, userId: args.member.userId },
      signal,
    );
    signal.throwIfAborted();
    // The timezone is the member's own preference, so it is kept like an
    // admin's. The industry and subscription answers are not: they only seed
    // organization defaults, which a member does not own.
    const timezone = await settle(
      set(
        preserveOrStoreTimezoneFallback$,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          timezone: args.timezone,
        },
        signal,
      ),
      signal,
    );
    if (timezone.ok) {
      L.debug("Member onboarding completed", {
        orgId: args.orgId,
        userId: args.member.userId,
        firstCompletion,
        timezone: timezone.value,
      });
    } else {
      L.warn("Member onboarding timezone fallback failed", {
        orgId: args.orgId,
        userId: args.member.userId,
        firstCompletion,
        error: timezone.error,
      });
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

export const completeOnboarding$ = command(
  async (
    { set },
    args: CompleteOnboardingArgs,
    signal: AbortSignal,
  ): Promise<CompleteOnboardingResponse> => {
    await set(
      initializeMemberMemory$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!args.isAdmin) {
      return await set(completeMemberOnboarding$, args, signal);
    }
    await set(
      markOrgOnboardingComplete$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        industry: args.industry,
      },
      signal,
    );
    signal.throwIfAborted();

    const timezone = await settle(
      set(
        preserveOrStoreTimezoneFallback$,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          timezone: args.timezone,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!timezone.ok) {
      L.warn("Member onboarding timezone fallback failed", {
        orgId: args.orgId,
        userId: args.member.userId,
        error: timezone.error,
      });
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
