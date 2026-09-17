import { command, computed, state, type Command, type State } from "ccstate";
import { clerk$, user$ } from "../auth.ts";
import { rootSignal$, rootVersion$ } from "../root-signal.ts";
import { onRejection, waitForOperation } from "../utils.ts";
import { readStoredAdAttributionMetadata$ } from "./ad-attribution.ts";

export const readAttributionContext$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const user = await get(user$);
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const userId = user?.id;
    const sessionId = clerk.session?.id;
    const orgId = clerk.organization?.id;
    const attribution = set(readStoredAdAttributionMetadata$);
    const assertCurrent = () => {
      if (
        clerk.user?.id !== userId ||
        clerk.session?.id !== sessionId ||
        clerk.organization?.id !== orgId
      ) {
        throw new DOMException("Attribution identity changed", "AbortError");
      }
    };
    assertCurrent();
    return {
      user,
      attribution,
      key: JSON.stringify([userId, sessionId, orgId, attribution]),
      assertCurrent,
      getTokenGuard: () => {
        assertCurrent();
        return assertCurrent;
      },
    };
  },
);

export type AttributionContext = Awaited<
  ReturnType<(typeof readAttributionContext$)["write"]>
>;

interface AttributionRequest<T> {
  readonly key: string;
  readonly id: symbol;
  readonly operation: Promise<T>;
}

/** One attribution operation per current identity/input, owned by the app root. */
export function createAttributionRequest<T>(
  execute$: Command<Promise<T>, [AttributionContext, AbortSignal]>,
  reuse: (result: T) => boolean,
) {
  // Commands initiate these checks; the computed only scopes their bookkeeping.
  // Replacing the root releases the old slot instead of retaining an identity map.
  const requestState$ = computed((get) => {
    get(rootVersion$);
    return state<AttributionRequest<T> | null>(null);
  });

  const invalidate$ = command(({ get, set }) => {
    // Existing callers still own their captured request. A signup check may
    // invalidate reuse while checkout is waiting; cancelling that transport
    // would cancel the checkout action as well.
    set(get(requestState$), null);
  });

  const executeRequest$ = command(
    async (
      { get, set },
      context: AttributionContext,
      id: symbol,
      request$: State<AttributionRequest<T> | null>,
      signal: AbortSignal,
    ) => {
      const result = await set(execute$, context, signal);
      context.assertCurrent();
      if (!reuse(result) && get(request$)?.id === id) {
        set(request$, null);
      }
      return result;
    },
  );

  const request$ = command(
    async ({ get, set }, context: AttributionContext, signal: AbortSignal) => {
      signal.throwIfAborted();
      const rootSignal = get(rootSignal$);
      rootSignal.throwIfAborted();
      context.assertCurrent();
      const request$ = get(requestState$);
      let request = get(request$);
      if (request?.key !== context.key) {
        const id = Symbol();
        const operation = onRejection(
          set(executeRequest$, context, id, request$, rootSignal),
          () => {
            if (get(request$)?.id === id) {
              set(request$, null);
            }
          },
        );
        request = { key: context.key, id, operation };
        set(request$, request);
      }
      const result = await waitForOperation(request.operation, signal);
      signal.throwIfAborted();
      context.assertCurrent();
      return result;
    },
  );

  return { request$, invalidate$ };
}
