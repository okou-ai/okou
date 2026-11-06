import {
  command,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { resetSignal } from "../../utils.ts";
import type { createInputSession } from "../input/session.ts";
import type { createDisplayViewport } from "../display/viewport.ts";
import type { AttachedSelection } from "./selection.ts";
import type { createScreencast } from "./screencast.ts";
import type { ViewerIntent } from "./lifecycle.ts";

interface VisibilityNodes {
  readonly attached: AttachedSelection;
  readonly alive$: Computed<boolean>;
  readonly presenting$: State<boolean>;
  readonly invalidatePicture$: Command<void, []>;
  readonly input: ReturnType<typeof createInputSession>;
  readonly stream: ReturnType<typeof createScreencast>;
  readonly geometry: ReturnType<typeof createDisplayViewport>;
  readonly prepareRetry$: Command<Promise<void>, [AbortSignal]>;
}
type WaitForDisplay = Command<Promise<void>, [AbortSignal]> | null;

/** Visibility cancels readmission; original release/stop receipts keep their owner. */
export function createSelectedVisibility(
  nodes: VisibilityNodes,
  intent$: Computed<ViewerIntent>,
) {
  const {
    attached,
    alive$,
    presenting$,
    invalidatePicture$,
    input,
    stream,
    geometry,
    prepareRetry$,
  } = nodes;
  const resetResume$ = resetSignal();
  const receipt$ = state<Promise<PromiseSettledResult<void>> | null>(null);
  const cancel$ = command(({ set }) => {
    set(resetResume$, AbortSignal.abort());
  });
  const release$ = command(
    async (
      { set },
      waitForDisplay$: WaitForDisplay,
      signal: AbortSignal,
    ): Promise<PromiseSettledResult<void>> => {
      const results = await Promise.allSettled([
        set(input.suspend$, attached.client.signal),
        set(stream.quiesce$, attached.frames.signal),
        ...(waitForDisplay$ ? [set(waitForDisplay$, signal)] : []),
      ]);
      signal.throwIfAborted();
      return (
        results.find((result) => {
          return result.status === "rejected";
        }) ?? { status: "fulfilled", value: undefined }
      );
    },
  );
  const pause$ = command(({ set }, waitForDisplay$: WaitForDisplay) => {
    set(cancel$);
    set(presenting$, false);
    set(invalidatePicture$);
    set(stream.pause$);
    set(geometry.suspendPresentation$);
    const completion = set(release$, waitForDisplay$, attached.client.signal);
    set(receipt$, completion);
    return completion;
  });
  const preparing$ = command(({ set }) => {
    set(geometry.resumePresentation$);
    set(presenting$, true);
  });
  const resume$ = command(async ({ get, set }, signal: AbortSignal) => {
    const operation = set(resetResume$, attached.client.signal, signal);
    const receipt = get(receipt$);
    if (receipt) {
      const result = await receipt;
      signal.throwIfAborted();
      operation.throwIfAborted();
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    if (!get(alive$) || get(intent$).paused) {
      return;
    }
    await set(stream.retry$, prepareRetry$, preparing$, operation);
    signal.throwIfAborted();
    operation.throwIfAborted();
    // Preserve established-session proof while its new picture is pending.
    // Another hide must pause this owner rather than retire it.
  });
  return { pause$, resume$, cancel$, receipt$, presenting$ };
}
