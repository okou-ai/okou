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
  current$: Computed<boolean>,
) {
  return {
    client,
    sessionId,
    current$,
    scope: Object.freeze({}),
    document$: state<ViewerNavigation | null>(null),
    attachment$: state<{ readonly ended: DeferredPromise<never> } | null>(null),
    historyVersion$: state(0),
  };
}
type NavigationState = ReturnType<typeof createNavigationState>;

function createNavigationReads(graph: NavigationState) {
  const {
    client,
    sessionId,
    current$,
    document$,
    attachment$,
    historyVersion$,
  } = graph;
  const navigation$ = computed((get) => {
    return get(current$) ? get(document$) : null;
  });
  const history$ = computed(async (get): Promise<ViewerHistory | null> => {
    const attachment = get(attachment$);
    get(historyVersion$);
    if (!attachment || !get(current$) || !get(document$)) {
      return null;
    }
    const history = await Promise.race([
      client.request("Page.getNavigationHistory", undefined, sessionId),
      attachment.ended.promise,
    ]);
    if (!get(current$)) {
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
    if (!attachment || !get(current$)) {
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
    if (!get(current$)) {
      throw cancelled();
    }
    return history;
  });
  return { navigation$, history$, readHistory$ };
}

function createNavigationObservation(graph: NavigationState) {
  const { current$, document$, attachment$, historyVersion$ } = graph;
  const invalidateHistory$ = command(({ set }) => {
    set(historyVersion$, (value) => {
      return value + 1;
    });
  });
  const observe$ = command(({ get, set }, frame: Protocol.Page.Frame) => {
    if (!get(current$) || !get(attachment$) || get(document$) !== null) {
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
    if (event.sessionId !== graph.sessionId || !get(current$)) {
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
      params.frameId === get(document$)?.frameId &&
      typeof params.url === "string"
    ) {
      const document = get(document$)!;
      set(document$, Object.freeze({ ...document, url: params.url }));
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
  current$: Computed<boolean>,
) {
  const graph = createNavigationState(client, sessionId, current$);
  const start$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(graph.attachment$, { ended: createDeferredPromise<never>(signal) });
  });
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
    start$,
    dispose$,
    ...createNavigationReads(graph),
    ...createNavigationObservation(graph),
  };
}
export type NavigationData = ReturnType<typeof createNavigationData>;
