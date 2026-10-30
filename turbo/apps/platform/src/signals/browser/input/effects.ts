import { command, state } from "ccstate";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { detach, Reason } from "../../utils.ts";
import type { CdpClient } from "../cdp/client.ts";
import { CdpFault } from "../cdp/errors.ts";

type Method =
  | "Input.dispatchKeyEvent"
  | "Input.dispatchMouseEvent"
  | "Input.insertText"
  | "Input.imeSetComposition"
  | "Page.navigate"
  | "Page.reload"
  | "Page.navigateToHistoryEntry";
type Params<M extends Method> = ProtocolMapping.Commands[M]["paramsType"][0];
export type InputOperation<M extends Method = Method> = {
  [K in M]: { readonly method: K; readonly params: Params<K> };
}[M];
export type InputReceipt<T = unknown> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: unknown };

function createEffectState(client: CdpClient, sessionId: string) {
  return {
    client,
    sessionId,
    receipts$: state<ReadonlyMap<object, Promise<InputReceipt>>>(new Map()),
    failed$: state(false),
    imeSupported$: state(false),
    imeUnsupported$: state(false),
  };
}
type EffectState = ReturnType<typeof createEffectState>;

function createEffectReceipts(graph: EffectState) {
  const {
    client,
    sessionId,
    receipts$,
    failed$,
    imeSupported$,
    imeUnsupported$,
  } = graph;
  const receive$ = command(
    async (
      { get, set },
      token: object,
      operation: InputOperation,
      signal: AbortSignal,
    ): Promise<InputReceipt> => {
      using _receipt = {
        [Symbol.dispose]: () => {
          const remaining = new Map(get(receipts$));
          remaining.delete(token);
          set(receipts$, remaining);
        },
      };
      const [result] = await Promise.allSettled([
        client.request(
          operation.method,
          operation.params,
          sessionId,
          undefined,
          signal,
        ),
      ]);
      signal.throwIfAborted();
      if (result.status === "fulfilled") {
        if (operation.method === "Input.imeSetComposition") {
          set(imeSupported$, true);
        }
      } else if (
        operation.method === "Input.imeSetComposition" &&
        result.reason instanceof CdpFault &&
        result.reason.code === -32_601
      ) {
        set(imeUnsupported$, true);
      } else {
        set(failed$, true);
      }
      return result.status === "fulfilled"
        ? { ok: true, result: result.value }
        : { ok: false, error: result.reason };
    },
  );
  const issue$ = command(
    ({ get, set }, operation: InputOperation): Promise<InputReceipt> => {
      if (get(receipts$).size >= 128) {
        set(failed$, true);
        const error = new CdpFault("input", "Too many pending input effects.");
        client.close(error);
        return Promise.resolve({ ok: false, error });
      }
      const token = Object.freeze({});
      // Resolve the fixed native wire owner when work is admitted, never while
      // constructing this graph inside an identity-derived computed.
      const receipt = set(receive$, token, operation, graph.client.signal);
      set(receipts$, new Map(get(receipts$)).set(token, receipt));
      return receipt;
    },
  );
  return { issue$ };
}

function createEffectRequests(
  graph: EffectState,
  receipts: ReturnType<typeof createEffectReceipts>,
) {
  const { receipts$, failed$, imeSupported$, imeUnsupported$ } = graph;
  const { issue$ } = receipts;
  const awaitRequest$ = command(
    async (
      { set },
      operation: InputOperation,
      signal: AbortSignal,
    ): Promise<unknown> => {
      const outcome = await set(issue$, operation);
      signal.throwIfAborted();
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.result;
    },
  );
  const request$ = command(
    ({ set }, operation: InputOperation): Promise<unknown> => {
      return set(awaitRequest$, operation, graph.client.signal);
    },
  );
  const notify$ = command(({ set }, operation: InputOperation): void => {
    detach(
      set(issue$, operation),
      Reason.DomCallback,
      "browser input protocol receipt",
    );
  });
  const awaitCompletion$ = command(
    async ({ get }, signal: AbortSignal): Promise<void> => {
      while (get(receipts$).size) {
        await Promise.all(get(receipts$).values());
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      if (get(failed$) || (get(imeSupported$) && get(imeUnsupported$))) {
        throw new CdpFault("input", "Original input cleanup is unconfirmed.");
      }
    },
  );
  const completion$ = command(({ set }): Promise<void> => {
    return set(awaitCompletion$, graph.client.signal);
  });
  return { request$, notify$, completion$ };
}

/** Native receipts retain their original session, independently of input admission. */
export function createInputEffects(client: CdpClient, sessionId: string) {
  const graph = createEffectState(client, sessionId);
  const receipts = createEffectReceipts(graph);
  return createEffectRequests(graph, receipts);
}
export type InputEffects = ReturnType<typeof createInputEffects>;
