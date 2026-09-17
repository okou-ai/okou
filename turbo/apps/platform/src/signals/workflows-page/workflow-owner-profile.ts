import { command, computed } from "ccstate";
import {
  workflowsDetailContract,
  type WorkflowOwnerProfile,
} from "@okouai/api-contracts/contracts/workflows";

import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { clerk$, currentOrgInfo$, currentUserInfo$ } from "../auth.ts";
import { onRejection, resetSignal } from "../utils.ts";
import { pageVersion$ } from "../page-signal.ts";

const MAX_PROFILES = 32;
const PROFILE_TTL_MS = 15 * 60 * 1000;
const UNAVAILABLE_TTL_MS = 60 * 1000;

interface ProfileEntry {
  readonly promise: Promise<WorkflowOwnerProfile>;
  expiresAt: number;
}

function scopeKey(page: number, userId?: string, orgId?: string): string {
  return JSON.stringify([page, userId, orgId]);
}

// A reactive identity guard hides a completed response immediately on account,
// organization or page changes, including a transition whose identity is pending.
export const workflowOwnerProfileIdentity$ = computed(async (get) => {
  const page = get(pageVersion$);
  const user = await get(currentUserInfo$);
  const org = await get(currentOrgInfo$);
  return scopeKey(page, user?.id, org?.id);
});

async function readOwnerProfile(
  createClient: ApiClientFactory,
  workflowId: string,
  signal: AbortSignal,
): Promise<WorkflowOwnerProfile> {
  // An older API's missing route is an ordinary retryable author-row error,
  // never an authoritative missing user. Only 200 responses enter the cache.
  const response = await accept(
    createClient(workflowsDetailContract).ownerProfile({
      params: { workflowId },
      fetchOptions: { signal },
    }),
    [200],
    signal,
    { showErrorToast: false },
  );
  return response.body;
}

function createProfileLoader(page: number) {
  const cache = {
    page,
    profiles: new Map<string, ProfileEntry>(),
    identity: "",
    bound: false,
    signal: undefined as AbortSignal | undefined,
  };
  const resetProfileSignal$ = resetSignal();
  return command(
    async ({ get, set }, workflowId: string, signal: AbortSignal) => {
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const identity = scopeKey(
        cache.page,
        clerk.user?.id,
        clerk.organization?.id,
      );
      if (!cache.bound) {
        cache.bound = true;
        const unsubscribe = clerk.addListener(() => {
          const nextIdentity = scopeKey(
            cache.page,
            clerk.user?.id,
            clerk.organization?.id,
          );
          if (cache.identity !== nextIdentity) {
            set(resetProfileSignal$);
            cache.profiles.clear();
          }
        });
        signal.addEventListener(
          "abort",
          () => {
            unsubscribe();
            cache.profiles.clear();
          },
          { once: true },
        );
      }
      if (
        !cache.signal ||
        cache.identity !== identity ||
        cache.signal.aborted
      ) {
        cache.profiles.clear();
        cache.identity = identity;
        cache.signal = set(resetProfileSignal$, signal);
      }
      const requestSignal = cache.signal;
      for (const [id, entry] of cache.profiles) {
        if (entry.expiresAt <= now()) {
          cache.profiles.delete(id);
        }
      }
      const cached = cache.profiles.get(workflowId);
      if (cached) {
        const profile = await cached.promise;
        signal.throwIfAborted();
        requestSignal.throwIfAborted();
        return { scopeKey: identity, workflowId, profile };
      }
      if (cache.profiles.size >= MAX_PROFILES) {
        const oldest = [...cache.profiles].find(([, entry]) => {
          return Number.isFinite(entry.expiresAt);
        });
        if (!oldest) {
          throw new Error("Workflow owner profiles are busy");
        }
        cache.profiles.delete(oldest[0]);
      }
      const entry: ProfileEntry = {
        promise: readOwnerProfile(get(apiClient$), workflowId, requestSignal),
        expiresAt: Infinity,
      };
      cache.profiles.set(workflowId, entry);
      const profile = await onRejection(entry.promise, () => {
        // Keep the original error; a later open retries this optional row.
        if (cache.profiles.get(workflowId) === entry) {
          cache.profiles.delete(workflowId);
        }
      });
      signal.throwIfAborted();
      requestSignal.throwIfAborted();
      entry.expiresAt =
        now() +
        (profile.displayName === null && profile.imageUrl === null
          ? UNAVAILABLE_TTL_MS
          : PROFILE_TTL_MS);
      return { scopeKey: identity, workflowId, profile };
    },
  );
}

// Exactly one bounded loader per Store/page. Construction allocates no external
// resources; only an actual open binds cleanup and installs the page signal.
const profileLoader$ = computed((get) => {
  return createProfileLoader(get(pageVersion$));
});

export const loadWorkflowOwnerProfile$ = command(
  async ({ get, set }, workflowId: string, signal: AbortSignal) => {
    return await set(get(profileLoader$), workflowId, signal);
  },
);
