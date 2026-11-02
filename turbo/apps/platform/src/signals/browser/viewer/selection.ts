import { command, computed, state, type Command, type Computed } from "ccstate";
import type { CdpClient } from "../cdp/client.ts";
import type { CaptureSettings } from "./capture.ts";

export interface SelectionOwner {
  readonly targetId: string;
  readonly completion$: Computed<PromiseSettledResult<SelectionOutcome> | null>;
  readonly finish$: Command<void, [PromiseSettledResult<SelectionOutcome>]>;
}

interface SessionReceipt {
  readonly client: CdpClient;
  readonly sessionId: string;
}

export interface AttachedSelection {
  readonly owner: SelectionOwner;
  readonly client: CdpClient;
  readonly frames: CdpClient;
  readonly sessionId: string;
  readonly frameSessionId: string;
  readonly settings: CaptureSettings;
}

/** Supersession is a selection result, not a classification of arbitrary errors. */
export type SelectionOutcome = "ready" | "superseded";

interface SelectionIdentity {
  readonly targetId: string;
}

type Selection =
  | { readonly phase: "pending"; readonly identity: SelectionIdentity }
  | {
      readonly phase: "admitting";
      readonly identity: SelectionIdentity;
      readonly sessions: readonly SessionReceipt[];
    }
  | {
      readonly phase: "attached";
      readonly identity: SelectionIdentity;
      readonly attachment: AttachedSelection;
    };

/** Completion stays with its attempt even after current-selection retirement. */
function createSelectionOwner(targetId: string): SelectionOwner {
  const completed$ = state<PromiseSettledResult<SelectionOutcome> | null>(null);
  const completion$ = computed((get) => {
    return get(completed$);
  });
  const finish$ = command(
    ({ get, set }, result: PromiseSettledResult<SelectionOutcome>) => {
      if (!get(completed$)) {
        set(completed$, result);
      }
    },
  );
  return { targetId, completion$, finish$ };
}

/** One current selection; retired resources retain their original independent owners. */
export function createSelectionLifecycle() {
  const current$ = state<Selection | null>(null);
  const identity$ = computed((get) => {
    return get(current$)?.identity ?? null;
  });
  const owner$ = computed((get) => {
    const identity = get(identity$);
    return identity ? createSelectionOwner(identity.targetId) : null;
  });
  const attachment$ = computed((get) => {
    const current = get(current$);
    return current?.phase === "attached" ? current.attachment : null;
  });
  const sessions$ = computed((get): readonly SessionReceipt[] => {
    const current = get(current$);
    if (current?.phase === "admitting") {
      return current.sessions;
    }
    if (current?.phase !== "attached") {
      return [];
    }
    const { client, frames, sessionId, frameSessionId } = current.attachment;
    return frames === client
      ? [{ client, sessionId }]
      : [
          { client, sessionId },
          { client: frames, sessionId: frameSessionId },
        ];
  });
  const begin$ = command(({ get, set }, targetId: string): SelectionOwner => {
    set(current$, { phase: "pending", identity: { targetId } });
    return get(owner$)!;
  });
  const receive$ = command(
    ({ get, set }, owner: SelectionOwner, receipt: SessionReceipt): boolean => {
      const current = get(current$);
      if (!current || get(owner$) !== owner || current.phase === "attached") {
        return false;
      }
      set(current$, {
        phase: "admitting",
        identity: current.identity,
        sessions: [
          ...(current.phase === "admitting" ? current.sessions : []),
          receipt,
        ],
      });
      return true;
    },
  );
  const publish$ = command(
    ({ get, set }, attachment: AttachedSelection): boolean => {
      const current = get(current$);
      if (current?.phase !== "admitting" || get(owner$) !== attachment.owner) {
        return false;
      }
      set(current$, {
        phase: "attached",
        identity: current.identity,
        attachment,
      });
      return true;
    },
  );
  const release$ = command(({ get, set }, owner: SelectionOwner) => {
    const current = get(current$);
    if (current?.phase === "admitting" && get(owner$) === owner) {
      // Keep the operation owner until its original failure is classified.
      set(current$, { phase: "pending", identity: current.identity });
    }
  });
  const clear$ = command(({ set }) => {
    set(current$, null);
  });
  return {
    owner$,
    attachment$,
    sessions$,
    begin$,
    receive$,
    publish$,
    release$,
    clear$,
  };
}
