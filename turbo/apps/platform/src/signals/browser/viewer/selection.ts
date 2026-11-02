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

type Selection =
  | { readonly phase: "pending"; readonly owner: SelectionOwner }
  | {
      readonly phase: "admitting";
      readonly owner: SelectionOwner;
      readonly sessions: readonly SessionReceipt[];
    }
  | {
      readonly phase: "attached";
      readonly owner: SelectionOwner;
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
  const owner$ = computed((get) => {
    return get(current$)?.owner ?? null;
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
  const begin$ = command(({ set }, targetId: string): SelectionOwner => {
    const owner = createSelectionOwner(targetId);
    set(current$, { phase: "pending", owner });
    return owner;
  });
  const receive$ = command(
    ({ get, set }, owner: SelectionOwner, receipt: SessionReceipt): boolean => {
      const current = get(current$);
      if (current?.owner !== owner || current.phase === "attached") {
        return false;
      }
      set(current$, {
        phase: "admitting",
        owner,
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
      if (
        current?.phase !== "admitting" ||
        current.owner !== attachment.owner
      ) {
        return false;
      }
      set(current$, { phase: "attached", owner: attachment.owner, attachment });
      return true;
    },
  );
  const release$ = command(({ get, set }, owner: SelectionOwner) => {
    const current = get(current$);
    if (current?.phase === "admitting" && current.owner === owner) {
      // Keep the operation owner until its original failure is classified.
      set(current$, { phase: "pending", owner });
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
