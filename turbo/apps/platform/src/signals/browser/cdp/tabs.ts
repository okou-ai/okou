import { command, type Computed } from "ccstate";
import type {
  OkouBrowserClient,
  NativeTab,
  NativeEvent,
} from "@okouai/browser-extension-client";
import { createDeferredPromise } from "../../utils.ts";
import type { CdpClient, CdpEvent } from "./client.ts";
import { CdpFault, isRecord } from "./errors.ts";
import type { TargetDirectory } from "./targets.ts";

/** An established created target failed later publication; never create again. */
export class CreatedTabFault extends CdpFault {
  constructor(
    readonly targetId: string,
    cause: unknown,
  ) {
    super(
      cause instanceof CdpFault ? cause.kind : "tab",
      "The tab was created, but its view could not be prepared. Recover the existing tab.",
      cause instanceof CdpFault ? cause.code : undefined,
      cause instanceof CdpFault ? cause.request : undefined,
    );
    this.name = "CreatedTabFault";
    this.cause = cause;
  }
}

interface CreationOptions {
  readonly native: OkouBrowserClient;
  readonly windowId: number | null | undefined;
  readonly current$: Computed<boolean>;
}
interface CreationResources extends CreationOptions {
  readonly client: CdpClient;
  readonly directory: TargetDirectory;
}

/** Only nonce correlation, observations and acquired session receipts are local. */
function creationAttempt(signal: AbortSignal) {
  const token = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => {
      return byte.toString(16).padStart(2, "0");
    },
  ).join("");
  const changed = createDeferredPromise<void>(signal);
  return {
    marker: `about:blank#okou-create-${token}`,
    candidates: new Set<string>(),
    movedTabs: new Set<number>(),
    changed,
    observed: Promise.allSettled([changed.promise]),
    receipt: undefined as NativeTab | undefined,
    attached: undefined as string | undefined,
    targetId: undefined as string | undefined,
    movementOverflow: false,
    preparing: false,
    pageChanged: false,
    tabSequence: 0,
  };
}
type CreationAttempt = ReturnType<typeof creationAttempt>;

function ownsMarker(attempt: CreationAttempt, tab: NativeTab | null): boolean {
  const { receipt, marker } = attempt;
  return (
    !!tab &&
    !!receipt &&
    Number.isSafeInteger(tab.id) &&
    Number.isSafeInteger(tab.windowId) &&
    tab.id === receipt.id &&
    tab.windowId === receipt.windowId &&
    (tab.pendingUrl ?? tab.url) === marker
  );
}

function inspectMarker(attempt: CreationAttempt, info: unknown): void {
  if (
    isRecord(info) &&
    info.type === "page" &&
    info.url === attempt.marker &&
    typeof info.targetId === "string" &&
    info.targetId
  ) {
    if (attempt.candidates.size < 2) {
      attempt.candidates.add(info.targetId);
    }
    if (!attempt.changed.settled()) {
      attempt.changed.resolve();
    }
  }
}

function observeTarget(attempt: CreationAttempt, event: CdpEvent): void {
  if (event.sessionId !== undefined) {
    return;
  }
  const info = event.params.targetInfo;
  if (attempt.targetId) {
    if (
      event.method === "Target.targetDestroyed" &&
      event.params.targetId === attempt.targetId
    ) {
      attempt.pageChanged = true;
    }
    if (
      !attempt.preparing &&
      event.method === "Target.targetInfoChanged" &&
      isRecord(info) &&
      info.targetId === attempt.targetId &&
      info.url !== attempt.marker
    ) {
      attempt.pageChanged = true;
    }
  }
  if (
    ["Target.targetCreated", "Target.targetInfoChanged"].includes(event.method)
  ) {
    inspectMarker(attempt, info);
  }
}

function observeNative(attempt: CreationAttempt, event: NativeEvent): void {
  if (
    attempt.receipt &&
    (event.tabId === attempt.receipt.id ||
      event.removedTabId === attempt.receipt.id)
  ) {
    attempt.tabSequence = event.sequence;
  }
  if (
    !["tab-detached", "tab-attached", "tab-removed", "tab-replaced"].includes(
      event.kind,
    )
  ) {
    return;
  }
  for (const id of [event.tabId, event.removedTabId]) {
    if (id === undefined) {
      continue;
    }
    if (attempt.movedTabs.size >= 256) {
      attempt.movementOverflow = true;
    } else {
      attempt.movedTabs.add(id);
    }
  }
}

function createCreationEvidence(resources: CreationResources) {
  const check$ = command(
    (
      { get },
      attempt: CreationAttempt,
      sequence: number | undefined,
      signal: AbortSignal,
    ) => {
      const { native, client, current$ } = resources;
      signal.throwIfAborted();
      if (!get(current$) || native.signal.aborted || client.signal.aborted) {
        throw new CdpFault("tab", "The tab action is no longer current.");
      }
      if (attempt.candidates.size > 1) {
        throw new CdpFault(
          "tab",
          "The new tab could not be identified unambiguously.",
        );
      }
      if (
        attempt.movementOverflow ||
        attempt.pageChanged ||
        (sequence !== undefined && attempt.tabSequence > sequence) ||
        (attempt.receipt && attempt.movedTabs.has(attempt.receipt.id))
      ) {
        throw new CdpFault(
          "tab",
          "The new tab moved or navigated before it was ready.",
        );
      }
    },
  );
  const detach$ = command((_context, value: unknown) => {
    if (isRecord(value) && typeof value.sessionId === "string") {
      resources.client.notify("Target.detachFromTarget", {
        sessionId: value.sessionId,
      });
    }
  });
  const watch$ = command(
    (_context, attempt: CreationAttempt, signal: AbortSignal) => {
      const { native, client } = resources;
      signal.throwIfAborted();
      const releases = [
        native.onEvent((event) => {
          observeNative(attempt, event);
        }),
        client.onEvent((event) => {
          observeTarget(attempt, event);
        }),
      ];
      return () => {
        for (const release of releases) {
          release();
        }
        if (!attempt.changed.settled()) {
          attempt.changed.resolve();
        }
      };
    },
  );
  return { check$, detach$, watch$ };
}
type CreationEvidence = ReturnType<typeof createCreationEvidence>;

function createCreationVerification(
  resources: CreationResources,
  evidence: CreationEvidence,
) {
  return command(
    async (
      { set },
      attempt: CreationAttempt,
      signal: AbortSignal,
    ): Promise<number> => {
      const { client, native } = resources;
      const { check$ } = evidence;
      set(check$, attempt, undefined, signal);
      const id = attempt.targetId;
      if (!id) {
        throw new CdpFault("tab", "The new page is unavailable.");
      }
      const { targetInfo } = await client.request(
        "Target.getTargetInfo",
        { targetId: id },
        undefined,
        undefined,
        signal,
      );
      set(check$, attempt, undefined, signal);
      if (
        targetInfo.type !== "page" ||
        targetInfo.url !== attempt.marker ||
        targetInfo.targetId !== id
      ) {
        throw new CdpFault("tab", "The new page changed before it was ready.");
      }
      const window = await client.request(
        "Browser.getWindowForTarget",
        { targetId: id },
        undefined,
        undefined,
        signal,
      );
      set(check$, attempt, undefined, signal);
      const created = attempt.receipt;
      if (!created || window.windowId !== created.windowId) {
        throw new CdpFault("tab", "The new page moved before it was ready.");
      }
      // Native destination is last: pendingUrl may precede a CDP URL change.
      const observation = await native.call("getTab", { tabId: created.id });
      signal.throwIfAborted();
      set(check$, attempt, observation.startedSequence, signal);
      if (!ownsMarker(attempt, observation.value)) {
        throw new CdpFault(
          "tab",
          "The new tab moved or navigated before it was ready.",
        );
      }
      return observation.startedSequence;
    },
  );
}
type CreationVerification = ReturnType<typeof createCreationVerification>;

function createCreationPreparation(
  resources: CreationResources,
  evidence: CreationEvidence,
  verify$: CreationVerification,
) {
  return command(
    async (
      { set },
      attempt: CreationAttempt,
      signal: AbortSignal,
    ): Promise<number> => {
      const { client, native } = resources;
      const { check$, detach$ } = evidence;
      await set(verify$, attempt, signal);
      const session = await client.request(
        "Target.attachToTarget",
        { targetId: attempt.targetId!, flatten: true },
        undefined,
        (value) => {
          set(detach$, value);
        },
        signal,
      );
      // Retain the real acquisition before a cancellation check so finally detaches it.
      if (typeof session.sessionId !== "string" || !session.sessionId) {
        throw new CdpFault(
          "tab",
          "The browser returned an invalid new-tab session.",
        );
      }
      attempt.attached = session.sessionId;
      set(check$, attempt, undefined, signal);
      const verified = await set(verify$, attempt, signal);
      set(check$, attempt, verified, signal);
      attempt.preparing = true;
      const navigation = await client.request(
        "Page.navigate",
        { url: "about:blank" },
        attempt.attached,
        undefined,
        signal,
      );
      set(check$, attempt, undefined, signal);
      if (navigation.errorText) {
        throw new CdpFault("tab", "The new tab could not be prepared.");
      }
      const created = attempt.receipt;
      if (!created) {
        throw new CdpFault("tab", "The native new-tab receipt is unavailable.");
      }
      const observation = await native.call("getTab", { tabId: created.id });
      signal.throwIfAborted();
      set(check$, attempt, observation.startedSequence, signal);
      const tab = observation.value;
      if (
        tab?.id !== created.id ||
        tab.windowId !== created.windowId ||
        (tab.pendingUrl ?? tab.url) !== "about:blank"
      ) {
        throw new CdpFault("tab", "The new tab changed before it was ready.");
      }
      return observation.startedSequence;
    },
  );
}
type CreationPreparation = ReturnType<typeof createCreationPreparation>;

function createNativeCreation(
  resources: CreationResources,
  evidence: CreationEvidence,
  prepare$: CreationPreparation,
) {
  return command(
    async (
      { set },
      attempt: CreationAttempt,
      signal: AbortSignal,
    ): Promise<string> => {
      const { native, client } = resources;
      const windowId = resources.windowId ?? null;
      const { check$ } = evidence;
      set(check$, attempt, undefined, signal);
      // Keep a real receipt even when cancellation arrived while native create ran.
      attempt.receipt = (
        await native.call("createTab", {
          ...(windowId === null ? {} : { windowId }),
          url: attempt.marker,
        })
      ).value;
      signal.throwIfAborted();
      set(check$, attempt, undefined, signal);
      const receipt = attempt.receipt;
      if (
        !Number.isSafeInteger(receipt.id) ||
        !Number.isSafeInteger(receipt.windowId) ||
        (windowId !== null && receipt.windowId !== windowId)
      ) {
        throw new CdpFault("tab", "The native new-tab receipt is invalid.");
      }
      if (!attempt.candidates.size) {
        const targets = await client.request(
          "Target.getTargets",
          undefined,
          undefined,
          undefined,
          signal,
        );
        set(check$, attempt, undefined, signal);
        for (const info of targets.targetInfos) {
          inspectMarker(attempt, info);
        }
      }
      const [notification] = await attempt.observed;
      signal.throwIfAborted();
      if (notification.status === "rejected") {
        throw notification.reason;
      }
      set(check$, attempt, undefined, signal);
      const [id] = attempt.candidates;
      if (attempt.candidates.size !== 1 || !id) {
        throw new CdpFault(
          "tab",
          "The new tab could not be identified unambiguously.",
        );
      }
      attempt.targetId = id;
      const prepared = await set(prepare$, attempt, signal);
      await set(resources.directory.assertMember$, id, signal);
      set(check$, attempt, prepared, signal);
      return id;
    },
  );
}

function createCreationCleanup(resources: CreationResources) {
  // The final signal is the ORIGINAL native resource lifetime, not admission.
  return command(
    async (
      _context,
      attempt: CreationAttempt,
      signal: AbortSignal,
    ): Promise<void> => {
      const { native } = resources;
      signal.throwIfAborted();
      const receipt = attempt.receipt;
      if (!receipt) {
        return;
      }
      const observation = await native.call("getTab", { tabId: receipt.id });
      signal.throwIfAborted();
      if (
        attempt.tabSequence <= observation.startedSequence &&
        !attempt.pageChanged &&
        ownsMarker(attempt, observation.value) &&
        !attempt.movementOverflow &&
        !attempt.movedTabs.has(receipt.id)
      ) {
        // CDP correlation may be ambiguous; this native receipt still owns only
        // the exact unchanged tab created by this call, never a marker duplicate.
        await native.call("closeTab", { tabId: receipt.id });
        signal.throwIfAborted();
      }
    },
  );
}

/** Preconstructed commands; an ID alone never confers created-tab authority. */
export function createTabCreation(
  client: CdpClient,
  directory: TargetDirectory,
  options: CreationOptions,
) {
  const resources = { client, directory, ...options };
  const evidence = createCreationEvidence(resources);
  const verify$ = createCreationVerification(resources, evidence);
  const prepare$ = createCreationPreparation(resources, evidence, verify$);
  const create$ = createNativeCreation(resources, evidence, prepare$);
  const cleanup$ = createCreationCleanup(resources);
  const open$ = command(
    async ({ set }, signal: AbortSignal): Promise<string> => {
      const { native } = resources;
      const attempt = creationAttempt(signal);
      using _subscriptions = {
        [Symbol.dispose]: set(evidence.watch$, attempt, signal),
      };
      let established = false;
      await using _cleanup = {
        async [Symbol.asyncDispose]() {
          if (attempt.attached) {
            set(evidence.detach$, { sessionId: attempt.attached });
          }
          if (!established) {
            // Genuine cleanup belongs to the unchanged original native lifetime,
            // not this finite observer's potentially cancelled admission.
            await Promise.allSettled([set(cleanup$, attempt, native.signal)]);
          }
        },
      };
      const id = await set(create$, attempt, signal);
      established = true;
      return id;
    },
  );
  return { open$ };
}
