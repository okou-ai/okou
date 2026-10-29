import type { BrowserViewerActivity } from "@okouai/api-contracts/contracts/browser";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import {
  browserOwnerProfiles as profiles,
  browserOwnerWindows as windows,
} from "@okouai/db/schema/browser-owner";
import { command } from "ccstate";
import { and, desc, eq, gt, isNotNull, or } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import {
  controlBrowserOwner$,
  type BrowserPublicAuthority,
} from "./browser-owner.service";
import {
  BrowserUseProviderError,
  browserUseTargetWindow,
} from "./browser-use.service";
import { settleIncludingAbort } from "../utils";

export const renewSharedBrowserViewer$ = command(
  async (
    { get, set },
    input: {
      readonly owner: BrowserPublicAuthority;
      readonly cdpUrl: string;
      readonly activity: BrowserViewerActivity;
    },
    signal: AbortSignal,
  ) => {
    const { owner, activity } = input;
    const resolved = await settleIncludingAbort(
      browserUseTargetWindow(input.cdpUrl, activity.pageTargetId, signal),
    );
    signal.throwIfAborted();
    if (!resolved.ok) {
      throw resolved.error instanceof BrowserUseProviderError
        ? resolved.error
        : new BrowserUseProviderError(
            502,
            "BROWSER_USE_SHARED_OPERATION_FAILED",
            "Managed Browser operation could not be confirmed",
          );
    }
    const primaryWindowId = resolved.value;
    if (primaryWindowId === null) {
      return null;
    }
    // The selected window may belong to another chat. Derive that chat's own
    // authority; the route's Run and cached target list cannot authorize it.
    const [selected] = await get(db$)
      .select({ chatThreadId: windows.chatThreadId, runId: agentRuns.id })
      .from(windows)
      .innerJoin(profiles, eq(profiles.instanceId, windows.instanceId))
      .innerJoin(chatThreads, eq(chatThreads.id, windows.chatThreadId))
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, owner.orgId)),
      )
      .innerJoin(
        agentRuns,
        and(
          eq(agentRuns.chatThreadId, chatThreads.id),
          eq(agentRuns.agentId, agents.id),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.userId, owner.userId),
          isNotNull(agentRuns.triggerSource),
        ),
      )
      .where(
        and(
          eq(profiles.orgId, owner.orgId),
          eq(profiles.userId, owner.userId),
          eq(windows.instanceId, activity.instanceId),
          eq(windows.primaryWindowId, primaryWindowId),
          eq(windows.state, "active"),
          gt(windows.expiresAt, nowDate()),
          eq(chatThreads.userId, owner.userId),
          eq(chatThreads.cloudBrowserEnabled, true),
          owner.requireLiveRun
            ? eq(windows.chatThreadId, owner.chatThreadId)
            : undefined,
          owner.requireLiveRun ? eq(agentRuns.id, owner.runId) : undefined,
          or(eq(agents.visibility, "public"), eq(agents.owner, owner.userId)),
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    signal.throwIfAborted();
    if (!selected) {
      return null;
    }
    const result = await set(
      controlBrowserOwner$,
      {
        orgId: owner.orgId,
        userId: owner.userId,
        ...selected,
        requireLiveRun: owner.requireLiveRun,
      },
      {
        kind: "renew",
        instanceId: activity.instanceId,
        primaryWindowId,
      },
      signal,
    );
    return result.outcome === "accepted" ? (result.window ?? null) : null;
  },
);
