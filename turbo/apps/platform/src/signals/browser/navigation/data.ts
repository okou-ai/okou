import { command, computed, state, type Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import { createDeferredPromise, type DeferredPromise } from "../../utils.ts";
import type { CdpClient, CdpEvent } from "../cdp/client.ts";
import { isRecord } from "../cdp/errors.ts";
import type { ViewerHistory, ViewerNavigation } from "../viewer/types.ts";

function cancelled(): DOMException {
  return new DOMException(
    "The navigation attachment was retired.",
    "AbortError",
  );
}

function createNavigationState(
  client: CdpClient,
  sessionId: string,
  admitted$: Computed<boolean>,
) {
  return {
    client,
    sessionId,
    admitted$,
    scope: Object.freeze({}),
    document$: state<ViewerNavigation | null>(null),
    initialRevision$: state(0),
    attachment$: state<{ readonly ended: DeferredPromise<never> } | null>(null),
    historyVersion$: state(0),
  };
}
type NavigationState = ReturnType<typeof createNavigationState>;

function createNavigationReads(graph: NavigationState) {
  const {
    client,
    sessionId,
    admitted$,
    document$,
    attachment$,
    historyVersion$,
  } = graph;
  const navigation$ = computed((get) => {
    return get(admitted$) ? get(document$) : null;
  });
  const history$ = computed(async (get): Promise<ViewerHistory | null> => {
    const attachment = get(attachment$);
    get(historyVersion$);
    if (!attachment || !get(admitted$) || !get(document$)) {
      return null;
    }
    const history = await Promise.race([
      client.request("Page.getNavigationHistory", undefined, sessionId),
      attachment.ended.promise,
    ]);
    if (!get(admitted$)) {
      throw cancelled();
    }
    return {
      url: history.entries[history.currentIndex]?.url ?? null,
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
    };
  });
  const readHistory$ = command(async ({ get }, signal: AbortSignal) => {
    const attachment = get(attachment$);
    if (!attachment || !get(admitted$)) {
      throw cancelled();
    }
    const history = await Promise.race([
      client.request(
        "Page.getNavigationHistory",
        undefined,
        sessionId,
        undefined,
        signal,
      ),
      attachment.ended.promise,
    ]);
    signal.throwIfAborted();
    if (!get(admitted$)) {
      throw cancelled();
    }
    return history;
  });
  return { navigation$, history$, readHistory$ };
}

function createNavigationObservation(graph: NavigationState) {
  const { document$, attachment$, historyVersion$ } = graph;
  const invalidateHistory$ = command(({ set }) => {
    set(historyVersion$, (value) => {
      return value + 1;
    });
  });
  const observe$ = command(({ get, set }, frame: Protocol.Page.Frame) => {
    if (!get(attachment$) || get(document$) !== null) {
      return;
    }
    set(
      document$,
      Object.freeze({
        url: frame.url + (frame.urlFragment ?? ""),
        frameId: frame.id,
        loaderId: frame.loaderId,
      }),
    );
  });
  const event$ = command(({ get, set }, event: CdpEvent) => {
    // Retained attachments still receive document facts while admission is gated.
    if (event.sessionId !== graph.sessionId || !get(attachment$)) {
      return;
    }
    const { method, params } = event;
    if (
      method === "Page.frameNavigated" &&
      isRecord(params.frame) &&
      !params.frame.parentId &&
      typeof params.frame.id === "string" &&
      typeof params.frame.loaderId === "string" &&
      typeof params.frame.url === "string"
    ) {
      const fragment =
        typeof params.frame.urlFragment === "string"
          ? params.frame.urlFragment
          : "";
      set(
        document$,
        Object.freeze({
          url: params.frame.url + fragment,
          frameId: params.frame.id,
          loaderId: params.frame.loaderId,
        }),
      );
    } else if (
      method === "Page.navigatedWithinDocument" &&
      typeof params.frameId === "string" &&
      typeof params.url === "string"
    ) {
      const document = get(document$);
      if (!document) {
        // The first tree may precede this event. Re-read its native snapshot
        // instead of guessing whether this unknown frame is the main frame.
        set(graph.initialRevision$, (value) => {
          return value + 1;
        });
      } else if (params.frameId === document.frameId) {
        set(document$, Object.freeze({ ...document, url: params.url }));
      }
    } else if (
      method === "Page.loadEventFired" ||
      (method === "Page.frameStoppedLoading" &&
        params.frameId === get(document$)?.frameId)
    ) {
      set(invalidateHistory$);
    }
  });
  return { invalidateHistory$, observe$, event$ };
}

/** One real graph per attachment; input blur never owns document/history reads. */
export function createNavigationData(
  client: CdpClient,
  sessionId: string,
  admitted$: Computed<boolean>,
) {
  const graph = createNavigationState(client, sessionId, admitted$);
  const { observe$, ...observation } = createNavigationObservation(graph);
  const frameId$ = computed((get) => {
    return get(graph.document$)?.frameId ?? null;
  });
  const start$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const attachment = { ended: createDeferredPromise<never>(signal) };
      set(graph.attachment$, attachment);
      let observed = false;
      while (!observed) {
        const revision = get(graph.initialRevision$);
        const tree = await client.request(
          "Page.getFrameTree",
          undefined,
          sessionId,
          undefined,
          signal,
        );
        signal.throwIfAborted();
        if (get(graph.attachment$) !== attachment) {
          throw cancelled();
        }
        if (get(graph.document$)) {
          return;
        }
        if (revision !== get(graph.initialRevision$)) {
          continue;
        }
        set(observe$, tree.frameTree.frame);
        observed = true;
      }
    },
  );
  const dispose$ = command(({ get, set }) => {
    const attachment = get(graph.attachment$);
    if (attachment && !attachment.ended.settled()) {
      attachment.ended.reject(cancelled());
    }
    set(graph.attachment$, null);
    set(graph.document$, null);
  });
  return {
    scope: graph.scope,
    frameId$,
    start$,
    dispose$,
    ...createNavigationReads(graph),
    ...observation,
  };
}
export type NavigationData = ReturnType<typeof createNavigationData>;
