import { command, computed, state } from "ccstate";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import { toast } from "@okouai/ui/components/ui/sonner";
import { marketingHandoffsContract } from "@okouai/api-contracts/client/marketing-handoffs";
import type { MarketingHandoffManifest } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { accept } from "../../lib/accept.ts";
import { ApiError } from "../../lib/api-error.ts";
import { isNetworkRequestError } from "../../lib/network-error.ts";
import { i18n } from "../../i18n/index.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$, clerkUser$ } from "../auth.ts";
import { object, string, uuid } from "zod";
import { isAbortError, jsonParseOr } from "../utils.ts";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { logger } from "../log.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { createDraftSignals } from "../okou-page/chat-draft.ts";

const L = logger("MarketingHandoff");

// Receiving an optional task must not prevent normal App entry. Authentication,
// upgrades, cancellation, and programming errors still belong to their owners.
async function receiveMarketingHandoff<T>(
  request: Promise<T>,
  signal: AbortSignal,
  httpErrorNotified = false,
): Promise<{ ok: true; value: T } | { ok: false; notified: boolean }> {
  const [result] = await Promise.allSettled([request]);
  signal.throwIfAborted();
  if (result.status === "fulfilled") {
    return { ok: true, value: result.value };
  }
  const error: unknown = result.reason;
  if (isAbortError(error)) {
    throw error;
  }
  if (
    error instanceof ApiError &&
    error.status !== 401 &&
    error.status !== CLIENT_FORCE_UPGRADE_STATUS
  ) {
    L.warn("Unable to receive task", { status: error.status });
    return { ok: false, notified: httpErrorNotified };
  }
  if (isNetworkRequestError(error)) {
    L.warn("Unable to receive task", { kind: "network" });
    return { ok: false, notified: false };
  }
  throw error;
}

const discardUnavailableHandoff$ = command(
  ({ get, set }, hash: string, notify = true) => {
    const params = new URLSearchParams(get(searchParams$));
    if (params.get("handoff") !== hash) {
      return;
    }
    for (const key of [
      "handoff",
      "prompt",
      "model",
      "template",
      "connector",
      "showcase",
    ]) {
      params.delete(key);
    }
    set(internalHandoff$, null);
    set(replaceSearchParams$, params);
    if (notify) {
      toast.warning(
        i18n.t(($) => {
          return $.onboarding.handoffUnavailable;
        }),
        {
          id: "marketing-handoff-unavailable",
        },
      );
    }
  },
);

// A new user may receive a task before their organization has been provisioned.
const settledHandoffUser$ = state<{
  snapshot: Promise<unknown>;
  userId: string;
} | null>(null);
const handoffOwner$ = computed((get) => {
  const session = get(authenticatedSessionKey$);
  if (session) {
    return session;
  }
  const settled = get(settledHandoffUser$);
  return settled?.snapshot === get(clerkUser$) ? settled.userId : null;
});
const intentReadOwner$ = state<string | null>(null);
const cachedIntentSchema = object({
  owner: string(),
  hash: string(),
  intentId: uuid(),
});
const intentStorage = sessionStorageSignals("marketing_handoff_intent");
const handoffIntent$ = command(
  ({ get, set }, hash: string, previousHash?: string): string => {
    const owner = get(handoffOwner$);
    if (!owner) {
      throw new Error("Sign in before importing a Marketing request");
    }
    const navigation = performance.getEntriesByType("navigation")[0];
    const recovering =
      navigation &&
      "type" in navigation &&
      (navigation.type === "reload" || navigation.type === "back_forward");
    const cached = cachedIntentSchema.safeParse(
      jsonParseOr(set(intentStorage.readFresh$) ?? "null", null),
    );
    const canReuse = get(intentReadOwner$) === owner || recovering;
    const intentId =
      canReuse &&
      cached.success &&
      cached.data.owner === owner &&
      (cached.data.hash === hash || cached.data.hash === previousHash)
        ? cached.data.intentId
        : crypto.randomUUID();
    set(intentStorage.set$, JSON.stringify({ owner, hash, intentId }));
    set(intentReadOwner$, owner);
    return intentId;
  },
);

const internalHandoff$ = state<{
  owner: string | null;
  hash: string;
  intentId: string;
  manifest: MarketingHandoffManifest;
} | null>(null);
export const marketingHandoff$ = computed((get) => {
  const value = get(internalHandoff$);
  return value &&
    value.owner === get(handoffOwner$) &&
    value.hash === get(searchParams$).get("handoff")
    ? value
    : null;
});

/** Resolve only after auth bootstrap; credentials carry the API's host-only guest cookie. */
export const loadMarketingHandoff$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const hash = get(searchParams$).get("handoff");
    set(internalHandoff$, null);
    if (!hash) {
      return null;
    }
    const snapshot = get(clerkUser$);
    const user = await snapshot;
    signal.throwIfAborted();
    if (!user || snapshot !== get(clerkUser$)) {
      throw new DOMException("Session changed", "AbortError");
    }
    set(settledHandoffUser$, { snapshot, userId: user.id });
    const owner = get(handoffOwner$);
    const client = get(apiClient$)(marketingHandoffsContract);
    const resolved = await receiveMarketingHandoff(
      accept(
        client.resolve({
          params: { hash },
          body: {},
          fetchOptions: { signal, credentials: "include" },
        }),
        [200, 404],
        signal,
        { showErrorToast: false },
      ),
      signal,
    );
    signal.throwIfAborted();
    if (owner !== get(handoffOwner$)) {
      throw new DOMException("Session changed", "AbortError");
    }
    if (!resolved.ok || resolved.value.status === 404) {
      set(discardUnavailableHandoff$, hash, resolved.ok || !resolved.notified);
      return null;
    }
    const intentId = set(handoffIntent$, hash);
    const value = { owner, hash, intentId, manifest: resolved.value.body };
    set(internalHandoff$, value);
    return value;
  },
);

export const saveMarketingHandoff$ = command(
  async (
    { get, set },
    manifest: MarketingHandoffManifest,
    signal: AbortSignal,
  ) => {
    const owner = get(handoffOwner$);
    const result = await accept(
      get(apiClient$)(marketingHandoffsContract).create({
        body: manifest,
        fetchOptions: { signal, credentials: "include" },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (owner !== get(handoffOwner$)) {
      throw new DOMException("Session changed", "AbortError");
    }
    const hash = result.body.shortHash;
    const intentId = set(
      handoffIntent$,
      hash,
      get(searchParams$).get("handoff") ?? undefined,
    );
    set(internalHandoff$, {
      owner,
      hash,
      intentId,
      manifest,
    });
    return hash;
  },
);

const importMarketingHandoffFiles$ = command(
  async ({ get, set }, hash: string, signal: AbortSignal) => {
    const owner = get(handoffOwner$);
    const imported = await accept(
      get(apiClient$)(marketingHandoffsContract).import({
        params: { hash },
        body: { intentId: set(handoffIntent$, hash) },
        fetchOptions: { signal, credentials: "include" },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    if (owner !== get(handoffOwner$)) {
      throw new DOMException("Session changed", "AbortError");
    }
    return imported.body.files;
  },
);

export const createMarketingHandoffDraft$ = command(
  async ({ get, set }, hash: string, signal: AbortSignal) => {
    const owner = get(handoffOwner$);
    const files = await receiveMarketingHandoff(
      set(importMarketingHandoffFiles$, hash, signal),
      signal,
    );
    if (owner !== get(handoffOwner$)) {
      throw new DOMException("Session changed", "AbortError");
    }
    if (!files.ok) {
      set(discardUnavailableHandoff$, hash, !files.notified);
      return null;
    }
    const draft = createDraftSignals();
    // Shared attachment restoration already presents HTTP failures and missing
    // files. Reuse its notice without replacing the user's active draft.
    const restored = await receiveMarketingHandoff(
      set(draft.restoreAttachments$, files.value, signal),
      signal,
      true,
    );
    signal.throwIfAborted();
    if (owner !== get(handoffOwner$)) {
      throw new DOMException("Session changed", "AbortError");
    }
    if (!restored.ok || get(draft.attachments$).length !== files.value.length) {
      set(discardUnavailableHandoff$, hash, !restored.ok && !restored.notified);
      return null;
    }
    return draft;
  },
);

export const finishMarketingHandoff$ = command(
  (
    { get, set },
    completed: { owner: string | null; hash: string; intentId: string },
  ): void => {
    const current = get(internalHandoff$);
    if (
      !current ||
      current.owner !== completed.owner ||
      current.hash !== completed.hash ||
      current.intentId !== completed.intentId
    ) {
      return;
    }
    const cached = cachedIntentSchema.safeParse(
      jsonParseOr(set(intentStorage.readFresh$) ?? "null", null),
    );
    if (
      cached.success &&
      cached.data.intentId === completed.intentId &&
      cached.data.owner === completed.owner
    ) {
      set(intentStorage.clear$);
    }
    set(internalHandoff$, null);
  },
);
