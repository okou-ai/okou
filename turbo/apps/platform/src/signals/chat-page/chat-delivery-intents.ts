import { command, computed, state } from "ccstate";
import {
  chatEventsContract,
  chatThreadsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";
import { authenticatedIdentity$ } from "../auth.ts";
import { ApiError } from "../../lib/api-error.ts";
import { now } from "../../lib/time.ts";
import { jsonParseOr } from "../utils.ts";
import {
  listBrowserLocalStorageKeys,
  readBrowserLocalStorage,
  removeBrowserLocalStorage,
  serializeBrowserStorage,
  writeBrowserLocalStorage,
} from "../external/local-storage.ts";

/** A recovery copy is private browser data, not another server event log. */
export interface DeliveryIdentity {
  readonly userId: string;
  readonly orgId: string;
}

type PromptSendBody = Extract<ChatEventSendBody, { prompt: string }>;
export type DeliveryStatus = "prepared" | "accepted" | "rejected" | "uncertain";
export type DeliveryRejection = "authentication" | "rejected" | null;

/** Only a definite client-side HTTP rejection is classified as not sent. */
export function classifyDeliveryFailure(error: unknown): {
  status: "rejected" | "uncertain";
  rejection: DeliveryRejection;
} {
  const rejected =
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408;
  return {
    status: rejected ? "rejected" : "uncertain",
    rejection: rejected
      ? error.status === 401
        ? "authentication"
        : "rejected"
      : null,
  };
}

interface DeliveryIntentBase {
  readonly threadId: string;
  readonly clientEventId: string;
  readonly createdAt: string;
  readonly status: DeliveryStatus;
  readonly rejection: DeliveryRejection;
  readonly body: PromptSendBody;
}

export interface ExistingThreadDeliveryIntent extends DeliveryIntentBase {
  readonly kind: "existing-thread";
  readonly delivery: "run" | "queue";
  readonly optimisticSource?: {
    readonly runId: string;
    readonly threadId: string;
    readonly agentId: string;
    readonly titleSnapshot: string;
  };
}

/** Reserved for the new-thread sender: creation and prompt have separate outcomes. */
export interface NewThreadDeliveryIntent extends DeliveryIntentBase {
  readonly kind: "new-thread";
  readonly phase: "create" | "prompt";
  readonly createEventId: string;
  readonly createBody: typeof chatThreadsContract.create.body._output;
}

export type ChatDeliveryIntent =
  | ExistingThreadDeliveryIntent
  | NewThreadDeliveryIntent;

const PREFIX = "okou_chat-delivery-v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INTENTS = 24;
const MAX_INTENT_LENGTH = 256 * 1024;
const revision$ = state(0);

function key(identity: DeliveryIdentity, eventId: string): string {
  return `${PREFIX}${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.orgId)}:${eventId}`;
}

function ownerPrefix(identity: DeliveryIdentity): string {
  return key(identity, "");
}

function expired(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("createdAt" in value)) {
    return true;
  }
  const date = value.createdAt;
  const time = typeof date === "string" ? Date.parse(date) : Number.NaN;
  return !Number.isFinite(time) || time > now() || now() - time > MAX_AGE_MS;
}

function validBaseIntent(value: object, body: ChatEventSendBody): boolean {
  return (
    "clientEventId" in value &&
    typeof value.clientEventId === "string" &&
    body.clientEventId === value.clientEventId &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    (body.threadId ?? body.clientThreadId) === value.threadId &&
    "status" in value &&
    ["prepared", "accepted", "rejected", "uncertain"].includes(
      String(value.status),
    ) &&
    "rejection" in value &&
    [null, "authentication", "rejected"].includes(
      value.rejection as string | null,
    )
  );
}

function validNewThreadIntent(value: object, threadId: string): boolean {
  const creation =
    "createBody" in value
      ? chatThreadsContract.create.body.safeParse(value.createBody)
      : null;
  return (
    creation?.success === true &&
    creation.data.clientThreadId === threadId &&
    "phase" in value &&
    ["create", "prompt"].includes(String(value.phase)) &&
    "createEventId" in value &&
    typeof value.createEventId === "string"
  );
}

function parseIntent(raw: string | null): ChatDeliveryIntent | null {
  if (!raw || raw.length > MAX_INTENT_LENGTH) {
    return null;
  }
  const value = jsonParseOr<unknown>(raw, null);
  if (expired(value) || typeof value !== "object" || value === null) {
    return null;
  }
  if (!("body" in value)) {
    return null;
  }
  const body = chatEventsContract.send.body.safeParse(value.body);
  if (!body.success || !("prompt" in body.data)) {
    return null;
  }
  if (!validBaseIntent(value, body.data)) {
    return null;
  }
  if ("kind" in value && value.kind === "existing-thread") {
    if (
      !("delivery" in value) ||
      !["run", "queue"].includes(String(value.delivery))
    ) {
      return null;
    }
    return value as unknown as ExistingThreadDeliveryIntent;
  }
  if ("kind" in value && value.kind === "new-thread") {
    if (
      !validNewThreadIntent(
        value,
        body.data.threadId ?? body.data.clientThreadId ?? "",
      )
    ) {
      return null;
    }
    return value as unknown as NewThreadDeliveryIntent;
  }
  return null;
}

/** No unresolved intent is evicted to make room for a new send. */
export function listDeliveryIntents(
  identity: DeliveryIdentity,
): ChatDeliveryIntent[] {
  const result: ChatDeliveryIntent[] = [];
  const prefix = ownerPrefix(identity);
  for (const itemKey of listBrowserLocalStorageKeys(prefix) ?? []) {
    const intent = parseIntent(readBrowserLocalStorage(itemKey) ?? null);
    if (intent && itemKey === key(identity, intent.clientEventId)) {
      result.push(intent);
    } else {
      removeBrowserLocalStorage(itemKey);
    }
  }
  return result;
}

export function saveDeliveryIntent(
  identity: DeliveryIdentity,
  intent: ChatDeliveryIntent,
): boolean {
  const serialized = serializeBrowserStorage(intent);
  if (!serialized || serialized.length > MAX_INTENT_LENGTH || expired(intent)) {
    return false;
  }
  const itemKey = key(identity, intent.clientEventId);
  listDeliveryIntents(identity); // Prune expired entries before enforcing the bound.
  const existing = readBrowserLocalStorage(itemKey);
  const keys = listBrowserLocalStorageKeys(ownerPrefix(identity));
  if (
    existing === undefined ||
    keys === null ||
    (existing === null && keys.length >= MAX_INTENTS)
  ) {
    return false;
  }
  return writeBrowserLocalStorage(itemKey, serialized);
}

export function updateDeliveryIntent(
  identity: DeliveryIdentity,
  eventId: string,
  update: Partial<Pick<ChatDeliveryIntent, "status" | "rejection">> & {
    phase?: "create" | "prompt";
  },
): boolean {
  const original = listDeliveryIntents(identity).find((item) => {
    return item.clientEventId === eventId;
  });
  if (update.phase !== undefined && original?.kind !== "new-thread") {
    return false;
  }
  return original
    ? saveDeliveryIntent(identity, {
        ...original,
        ...update,
      } as ChatDeliveryIntent)
    : false;
}

export async function withDeliveryLock<T>(
  identity: DeliveryIdentity,
  eventId: string,
  phase: "create" | "prompt",
  signal: AbortSignal,
  action: () => Promise<T>,
): Promise<T | null> {
  // A retry is never safe across tabs without a cross-tab lock. The initial
  // send can use a unique ID on older browsers, but recovery must fail closed.
  if (!navigator.locks) {
    return null;
  }
  return await navigator.locks.request(
    key(identity, `${eventId}:${phase}`),
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock || signal.aborted) {
        return null;
      }
      return await action();
    },
  );
}

export function removeDeliveryIntent(
  identity: DeliveryIdentity,
  eventId: string,
): void {
  removeBrowserLocalStorage(key(identity, eventId));
}

export const deliveryIntentsChanged$ = command(({ set }) => {
  set(revision$, (previous) => {
    return previous + 1;
  });
});

/** Refresh after writes and across tabs without importing another account's data. */
export const markDeliveryIntentUncertain$ = command(
  async ({ get, set }, eventId: string, signal: AbortSignal) => {
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    updateDeliveryIntent(identity, eventId, {
      status: "uncertain",
      rejection: null,
    });
    set(deliveryIntentsChanged$);
  },
);

export const watchDeliveryIntents$ = command(({ set }, signal: AbortSignal) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(PREFIX)) {
      set(deliveryIntentsChanged$);
    }
  };
  window.addEventListener("storage", onStorage, { signal });
});

export const deliveryIntents$ = computed(
  async (get): Promise<ChatDeliveryIntent[]> => {
    get(revision$);
    const identity = await get(authenticatedIdentity$);
    return listDeliveryIntents(identity);
  },
);

export function deliveryIntentsForThread(threadId: string) {
  return computed(async (get): Promise<ChatDeliveryIntent[]> => {
    return (await get(deliveryIntents$)).filter((intent) => {
      return intent.threadId === threadId;
    });
  });
}
