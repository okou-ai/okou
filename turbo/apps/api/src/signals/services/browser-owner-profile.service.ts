import { createHash } from "node:crypto";
import type { RunnerBrowserResponse } from "@okouai/api-contracts/contracts/runner-browser";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { browserOwnerProfiles } from "@okouai/db/schema/browser-owner";
import {
  browserProfiles,
  browserThreadProfiles,
} from "@okouai/db/schema/browser-session";
import { command, computed, type Computed } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { db$ } from "../external/db";
import { settle, settleIncludingAbort } from "../utils";
import {
  authorityStillCurrent,
  type BrowserOwnerAuthority,
  controlBrowserOwner$,
} from "./browser-owner.service";
import {
  BrowserUseProviderError,
  createBrowserUseProfile,
  deleteBrowserUseProfile,
  getBrowserUseProfile,
} from "./browser-use.service";

const PROFILE_CLEANUP_TIMEOUT_MS = 15_000;

/** A candidate remains unsafe to delete while publication is unresolved. */
const cleanupProfileCandidate$ = command(
  async (
    { get },
    owner: BrowserOwnerAuthority,
    providerProfileId: string,
    publicationUncertain: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const references = await db
      .select({ providerProfileId: browserOwnerProfiles.providerProfileId })
      .from(browserOwnerProfiles)
      .where(
        or(
          eq(browserOwnerProfiles.providerProfileId, providerProfileId),
          and(
            eq(browserOwnerProfiles.orgId, owner.orgId),
            eq(browserOwnerProfiles.userId, owner.userId),
          ),
        ),
      )
      .unionAll(
        db
          .select({ providerProfileId: browserProfiles.providerProfileId })
          .from(browserProfiles)
          .where(eq(browserProfiles.providerProfileId, providerProfileId)),
      )
      .unionAll(
        db
          .select({
            providerProfileId: browserThreadProfiles.providerProfileId,
          })
          .from(browserThreadProfiles)
          .where(
            eq(browserThreadProfiles.providerProfileId, providerProfileId),
          ),
      );
    signal.throwIfAborted();
    if (
      references.some((row) => {
        return row.providerProfileId === providerProfileId;
      }) ||
      (publicationUncertain && references.length === 0)
    ) {
      return;
    }
    // A different accepted owner profile is immutable through ordinary
    // allocation, so a late publication cannot adopt this candidate.
    const deleted = await settle(
      deleteBrowserUseProfile(providerProfileId, signal),
    );
    if (signal.aborted) {
      throw new BrowserUseProviderError(
        502,
        "BROWSER_USE_TIMEOUT",
        "Managed browser provider profile cleanup timed out",
      );
    }
    if (!deleted.ok) {
      throw deleted.error;
    }
  },
);

/** Construct the graph once; the route owns authentication and admission. */
export function createRunnerBrowserAllocation(
  owner$: Computed<Promise<BrowserOwnerAuthority | null>>,
) {
  const context$ = computed(async (get) => {
    const owner = await get(owner$);
    if (!owner) {
      return null;
    }
    const [row] = await get(db$)
      .select({
        profile: {
          providerProfileId: browserOwnerProfiles.providerProfileId,
          status: browserOwnerProfiles.status,
        },
      })
      .from(agentRuns)
      .leftJoin(
        browserOwnerProfiles,
        and(
          eq(browserOwnerProfiles.orgId, owner.orgId),
          eq(browserOwnerProfiles.userId, owner.userId),
        ),
      )
      .where(and(eq(agentRuns.id, owner.runId), authorityStillCurrent(owner)));
    return row ? { owner, profile: row.profile } : null;
  });

  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<RunnerBrowserResponse> => {
      const context = await get(context$);
      signal.throwIfAborted();
      if (
        !context ||
        (context.profile && context.profile.status !== "stopped")
      ) {
        return { outcome: "unavailable" };
      }
      const { owner, profile } = context;
      const providerProfileId = profile
        ? await getBrowserUseProfile(profile.providerProfileId, signal)
        : await createBrowserUseProfile(
            `okou-owner-profile-${createHash("sha256")
              .update(JSON.stringify([owner.orgId, owner.userId]))
              .digest("hex")}`,
            signal,
          );
      if (providerProfileId === null) {
        return { outcome: "unavailable" };
      }
      if (signal.aborted) {
        if (!profile) {
          await set(
            cleanupProfileCandidate$,
            owner,
            providerProfileId,
            false,
            AbortSignal.timeout(PROFILE_CLEANUP_TIMEOUT_MS),
          );
        }
        signal.throwIfAborted();
      }
      // Cancellation can arrive after publication committed; reconcile first.
      const published = await settleIncludingAbort(
        set(
          controlBrowserOwner$,
          owner,
          { kind: "allocate", providerProfileId },
          signal,
        ),
      );
      if (signal.aborted) {
        if (!profile) {
          await settle(
            set(
              cleanupProfileCandidate$,
              owner,
              providerProfileId,
              !published.ok,
              AbortSignal.timeout(PROFILE_CLEANUP_TIMEOUT_MS),
            ),
          );
          signal.throwIfAborted();
        }
        signal.throwIfAborted();
      }
      const adopted =
        published.ok &&
        published.value.outcome === "accepted" &&
        published.value.instance.providerProfileId === providerProfileId;
      const cleaned =
        !profile && !adopted
          ? await settle(
              set(
                cleanupProfileCandidate$,
                owner,
                providerProfileId,
                !published.ok,
                AbortSignal.timeout(PROFILE_CLEANUP_TIMEOUT_MS),
              ),
            )
          : null;
      signal.throwIfAborted();
      if (!published.ok) {
        throw published.error;
      }
      if (cleaned && !cleaned.ok) {
        throw cleaned.error;
      }
      return published.value;
    },
  );
}
