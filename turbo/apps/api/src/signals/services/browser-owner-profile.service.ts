import { createHash } from "node:crypto";
import { browserOwnerProfiles } from "@okouai/db/schema/browser-owner";
import {
  browserProfiles,
  browserThreadProfiles,
} from "@okouai/db/schema/browser-session";
import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { env } from "../../lib/env";
import { isUniqueViolation } from "../../lib/pg-errors";
import { db$ } from "../external/db";
import { settle, settleIncludingAbort } from "../utils";
import {
  type BrowserPublicAuthority,
  type BrowserOwnerResult,
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
    owner: BrowserPublicAuthority,
    {
      providerProfileId,
      previousProfileId,
    }: {
      readonly providerProfileId: string;
      readonly previousProfileId: string | null;
    },
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
    if (signal.aborted) {
      throw new BrowserUseProviderError(
        502,
        "BROWSER_USE_TIMEOUT",
        "Managed browser provider profile cleanup timed out",
      );
    }
    if (
      references.some((row) => {
        return row.providerProfileId === providerProfileId;
      }) ||
      (publicationUncertain &&
        (references.length === 0 ||
          references.some((row) => {
            return row.providerProfileId === previousProfileId;
          })))
    ) {
      return;
    }
    // A different accepted profile proves a loser only after the expected
    // predecessor is gone; its presence still permits late recovery publication.
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

export const allocateBrowserOwnerProfile$ = command(
  async (
    { set },
    owner: BrowserPublicAuthority,
    profile: {
      readonly providerProfileId: string;
      readonly instanceId: string;
      readonly status: string;
    } | null,
    signal: AbortSignal,
  ): Promise<BrowserOwnerResult> => {
    if (profile && profile.status !== "stopped") {
      return { outcome: "unavailable" };
    }
    const retainedProfileId = profile
      ? await getBrowserUseProfile(profile.providerProfileId, signal)
      : null;
    signal.throwIfAborted();
    // Only a confirmed missing profile permits fresh, empty-state recovery.
    const created = retainedProfileId === null;
    const providerProfileId =
      retainedProfileId ??
      (await createBrowserUseProfile(
        `okou-owner-profile-${createHash("sha256")
          .update(JSON.stringify([owner.orgId, owner.userId]))
          .digest("hex")}`,
        signal,
      ));
    const candidate = {
      providerProfileId,
      previousProfileId: profile?.providerProfileId ?? null,
    };
    if (signal.aborted) {
      if (created) {
        await set(
          cleanupProfileCandidate$,
          owner,
          candidate,
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
        {
          kind: "allocate",
          providerProfileId,
          browserExtensionId: env("OKOU_BROWSER_USE_EXTENSION_ID"),
          previousProfile: profile,
        },
        signal,
      ),
    );
    if (signal.aborted) {
      if (created) {
        await settle(
          set(
            cleanupProfileCandidate$,
            owner,
            candidate,
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
      published.value.profile.providerProfileId === providerProfileId;
    const cleaned =
      created && !adopted
        ? await settle(
            set(
              cleanupProfileCandidate$,
              owner,
              candidate,
              !published.ok,
              AbortSignal.timeout(PROFILE_CLEANUP_TIMEOUT_MS),
            ),
          )
        : null;
    signal.throwIfAborted();
    if (!published.ok) {
      if (
        isUniqueViolation(published.error, "uq_browser_owner_profiles_provider")
      ) {
        throw new BrowserUseProviderError(
          502,
          "BROWSER_USE_INVALID_RESPONSE",
          "Managed browser provider returned an already owned profile",
        );
      }
      throw published.error;
    }
    if (cleaned && !cleaned.ok) {
      throw cleaned.error;
    }
    return published.value;
  },
);
