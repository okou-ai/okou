import { command, state } from "ccstate";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { detach, Reason } from "../../utils.ts";
import type { CdpClient } from "../cdp/client.ts";
import { CdpFault, requestDetails } from "../cdp/errors.ts";

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
type EffectPhase = "input" | "cleanup";
type CompletionPhase = "completion" | "suspension" | "retirement";

/** Copy only finite protocol facts, never native error messages or input data. */
function receiptFault(
  method: Method,
  phase: EffectPhase,
  error: unknown,
): CdpFault {
  const code =
    error instanceof CdpFault &&
    error.code !== undefined &&
    Number.isSafeInteger(error.code)
      ? error.code
      : undefined;
  return new CdpFault(
    "input",
    `Original ${phase} receipt failed: ${method}${code === undefined ? "" : ` (CDP ${code})`}.`,
    code,
    Object.freeze({ method, ...(code === undefined ? {} : { code }) }),
  );
}

function createEffectState(client: CdpClient, sessionId: string) {
  return {
    client,
    sessionId,
    receipts$: state<ReadonlyMap<object, Promise<InputReceipt>>>(new Map()),
    failed$: state<CdpFault | null>(null),
    imeSupported$: state(false),
    imeUnsupported$: state<CdpFault | null>(null),
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
      phase: EffectPhase,
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
        set(
          imeUnsupported$,
          get(imeUnsupported$) ??
            receiptFault(operation.method, phase, result.reason),
        );
      } else {
        const rejectedNavigation =
          (operation.method === "Page.navigate" ||
            operation.method === "Page.reload" ||
            operation.method === "Page.navigateToHistoryEntry") &&
          result.reason instanceof CdpFault &&
          result.reason.code !== undefined;
        // A native navigation error response settles that command, not the
        // document's outcome. Input failures and unknown native outcomes still
        // leave original cleanup unconfirmed; no failed receipt is reset.
        if (!rejectedNavigation) {
          set(
            failed$,
            get(failed$) ??
              receiptFault(operation.method, phase, result.reason),
          );
        }
      }
      return result.status === "fulfilled"
        ? { ok: true, result: result.value }
        : { ok: false, error: result.reason };
    },
  );
  const issue$ = command(
    (
      { get, set },
      operation: InputOperation,
      phase: EffectPhase,
    ): Promise<InputReceipt> => {
      if (get(receipts$).size >= 128) {
        set(
          failed$,
          get(failed$) ??
            new CdpFault(
              "input",
              `Original ${phase} effect was not sent: pending input limit reached (${operation.method}).`,
              undefined,
              Object.freeze({ method: operation.method }),
            ),
        );
        const error = new CdpFault("input", "Too many pending input effects.");
        client.close(error);
        return Promise.resolve({ ok: false, error });
      }
      const token = Object.freeze({});
      // Resolve the fixed native wire owner when work is admitted, never while
      // constructing this graph inside an identity-derived computed.
      const receipt = set(
        receive$,
        token,
        operation,
        phase,
        graph.client.signal,
      );
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
      const outcome = await set(issue$, operation, "input");
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
      set(issue$, operation, "cleanup"),
      Reason.DomCallback,
      "browser input protocol receipt",
    );
  });
  const awaitCompletion$ = command(
    async (
      { get },
      phase: CompletionPhase,
      signal: AbortSignal,
    ): Promise<void> => {
      while (get(receipts$).size) {
        await Promise.all(get(receipts$).values());
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      const failure =
        get(failed$) ?? (get(imeSupported$) ? get(imeUnsupported$) : null);
      if (failure) {
        throw new CdpFault(
          "input",
          "Original input cleanup is unconfirmed.",
          undefined,
          requestDetails(failure),
          {
            cause: new Error(
              `Original input ${phase} failed${get(failed$) ? "" : " after mixed IME support"}.`,
              { cause: failure },
            ),
          },
        );
      }
    },
  );
  const completion$ = command(
    ({ set }, phase: CompletionPhase = "completion"): Promise<void> => {
      return set(awaitCompletion$, phase, graph.client.signal);
    },
  );
  return { request$, notify$, completion$ };
}

/** Native receipts retain their original session, independently of input admission. */
export function createInputEffects(client: CdpClient, sessionId: string) {
  const graph = createEffectState(client, sessionId);
  const receipts = createEffectReceipts(graph);
  return createEffectRequests(graph, receipts);
}
export type InputEffects = ReturnType<typeof createInputEffects>;
