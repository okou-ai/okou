import { command, computed, state } from "ccstate";
import { marketingHandoffsContract } from "@okouai/api-contracts/client/marketing-handoffs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { MarketingHandoffManifest } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$, clerkUser$ } from "../auth.ts";
import { object, string, uuid } from "zod";
import { jsonParseOr } from "../utils.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { searchParams$ } from "../route.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { createDraftSignals } from "../okou-page/chat-draft.ts";

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

/** Enroll an enabled App session so Marketing can resolve staff rollout without loading Clerk. */
export const enrollMarketingHandoffSession$ = command(
  async ({ get }, signal: AbortSignal) => {
    // Disabled or unprovisioned Marketing does not require session enrollment.
    const response = await accept(
      get(apiClient$)(marketingHandoffsContract).session({
        body: {},
        fetchOptions: { signal, credentials: "include" },
      }),
      [200, 403, 503],
    );
    signal.throwIfAborted();
    return response.status === 200;
  },
);

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
    const features = await get(featureSwitch$);
    signal.throwIfAborted();
    if (!features[FeatureSwitchKey.MarketingContentHandoff]) {
      throw new Error("Marketing content handoff is not enabled");
    }
    const client = get(apiClient$)(marketingHandoffsContract);
    const resolved = await accept(
      client.resolve({
        params: { hash },
        body: {},
        fetchOptions: { signal, credentials: "include" },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (owner !== get(handoffOwner$)) {
      throw new DOMException("Session changed", "AbortError");
    }
    const intentId = set(handoffIntent$, hash);
    const value = { owner, hash, intentId, manifest: resolved.body };
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
    const hash = result.body.shortHash ?? result.body.hash;
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

export const importMarketingHandoffFiles$ = command(
  async ({ get, set }, hash: string, signal: AbortSignal) => {
    const owner = get(handoffOwner$);
    const imported = await accept(
      get(apiClient$)(marketingHandoffsContract).import({
        params: { hash },
        body: { intentId: set(handoffIntent$, hash) },
        fetchOptions: { signal, credentials: "include" },
      }),
      [200],
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
    const files = await set(importMarketingHandoffFiles$, hash, signal);
    const draft = createDraftSignals();
    await set(draft.restoreAttachments$, files, signal);
    signal.throwIfAborted();
    if (get(draft.attachments$).length !== files.length) {
      throw new Error("The received attachments are no longer available");
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
