import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import type { ViewerSnapshot } from "cdp-viewer";
import {
  command,
  computed,
  state,
  type Computed,
  type State,
  type Command,
} from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { throttleCommand } from "../command-scheduling.ts";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";

/** Viewer controls that operate on the selected page, excluding tab selection. */
function selectedPageInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const control = target.closest("canvas, input, textarea, button");
  return (
    control instanceof HTMLCanvasElement ||
    (control instanceof HTMLTextAreaElement && !control.readOnly) ||
    (control instanceof HTMLInputElement &&
      (control.type === "url" || control.type === "text")) ||
    (control instanceof HTMLButtonElement &&
      [
        "Back remote page",
        "Forward remote page",
        "Reload remote page",
      ].includes(control.getAttribute("aria-label") ?? ""))
  );
}

interface ViewerSelection {
  readonly pageTargetId: string;
  readonly liveUrl: string;
  readonly instanceId: string;
}

export interface BrowserViewerActivitySignals {
  readonly setViewerStatus$: Command<
    void,
    [ViewerSnapshot, string, string | undefined]
  >;
  readonly viewerActivityRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

export function createBrowserViewerActivitySignals(input: {
  readonly threadId: string;
  readonly session$: Computed<Promise<BrowserSession | null>>;
  readonly leaseOverride$: State<BrowserSession | undefined>;
  readonly reload$: Command<void, []>;
}): BrowserViewerActivitySignals {
  const selection$ = state<ViewerSelection | null>(null);
  const resetActivity$ = resetSignal();
  const setViewerStatus$ = command(
    (
      { get, set },
      snapshot: ViewerSnapshot,
      liveUrl: string,
      instanceId: string | undefined,
    ) => {
      const selected =
        snapshot.status === "streaming" ? snapshot.selectedTargetId : null;
      const old = get(selection$);
      if (
        old?.pageTargetId === selected &&
        old.liveUrl === liveUrl &&
        old.instanceId === instanceId
      ) {
        return;
      }
      if (old === null && (!selected || !instanceId)) {
        return;
      }
      set(resetActivity$);
      set(
        selection$,
        selected && instanceId
          ? { pageTargetId: selected, liveUrl, instanceId }
          : null,
      );
    },
  );
  const renew$ = command(
    async ({ get, set }, selected: ViewerSelection, signal: AbortSignal) => {
      if (get(selection$) !== selected) {
        return;
      }
      const session = await get(input.session$);
      signal.throwIfAborted();
      if (
        get(selection$) !== selected ||
        session?.window?.instanceId !== selected.instanceId ||
        session.liveUrl !== selected.liveUrl
      ) {
        return;
      }
      const response = await accept(
        get(apiClient$)(browserContract).leaseByThread({
          params: { threadId: input.threadId },
          body: {
            viewerActivity: {
              instanceId: selected.instanceId,
              pageTargetId: selected.pageTargetId,
            },
          },
          fetchOptions: { signal },
        }),
        [200, 404, 409],
        signal,
      );
      signal.throwIfAborted();
      const current = await get(input.session$);
      signal.throwIfAborted();
      if (
        get(selection$) !== selected ||
        current?.window?.instanceId !== selected.instanceId ||
        current.liveUrl !== selected.liveUrl
      ) {
        return;
      }
      if (response.status !== 200) {
        set(input.reload$);
        return;
      }
      set(input.leaseOverride$, response.body.browser);
    },
  );
  const viewerMount$ = state(0);
  const scheduler$ = computed((get) => {
    // A remounted viewer owns a new scheduler and cancellation lifetime.
    get(viewerMount$);
    get(selection$);
    return throttleCommand(renew$, 60_000);
  });
  const viewerActivityRef$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      set(viewerMount$, get(viewerMount$) + 1);
      let previousSelection: ViewerSelection | null = null;
      let selectionSignal: AbortSignal | null = null;
      const onActivity = onDomEventFn((event: Event) => {
        const selected = get(selection$);
        if (!selected || !selectedPageInput(event.target)) {
          return;
        }
        if (
          selected !== previousSelection ||
          !selectionSignal ||
          selectionSignal.aborted
        ) {
          previousSelection = selected;
          selectionSignal = set(resetActivity$, signal);
        }
        return set(get(scheduler$), selected, selectionSignal);
      });
      for (const type of ["pointerdown", "keydown", "wheel", "input"]) {
        element.addEventListener(type, onActivity, {
          signal,
          capture: true,
          passive: true,
        });
      }
    }),
  );
  return { setViewerStatus$, viewerActivityRef$ };
}
