import { command, computed, state, type Command, type Computed } from "ccstate";
import { resetSignal } from "../../utils.ts";
import type { createInputSession } from "../input/session.ts";
import type { createDisplayViewport } from "../display/viewport.ts";
import type { AttachedSelection } from "./selection.ts";
import type { createScreencast } from "./screencast.ts";
import type { ViewerIntent } from "./lifecycle.ts";
import type { CaptureSettings } from "./capture.ts";

type Presentation =
  | { readonly phase: "suspended" }
  | {
      readonly phase: "preparing" | "capturing";
      readonly signal: AbortSignal;
    };

/** Foreground work can end while the original native resources still need cleanup. */
export function createPresentationScope(
  attached: AttachedSelection,
  alive$: Computed<boolean>,
  intent$: Computed<ViewerIntent>,
) {
  const current$ = state<Presentation>({ phase: "suspended" });
  const resetOperation$ = resetSignal();
  const presenting$ = computed((get) => {
    return get(current$).phase === "capturing";
  });
  const cancel$ = command(({ set }) => {
    set(current$, { phase: "suspended" });
    set(resetOperation$, AbortSignal.abort());
  });
  const scope$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(alive$) || get(intent$).paused) {
      throw new DOMException("Cancelled", "AbortError");
    }
    let current = get(current$);
    if (current.phase === "suspended") {
      current = {
        phase: "preparing",
        signal: set(
          resetOperation$,
          attached.client.signal,
          attached.frames.signal,
        ),
      };
      set(current$, current);
    }
    const operation = AbortSignal.any([current.signal, signal]);
    operation.throwIfAborted();
    return operation;
  });
  const replace$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(cancel$);
    return set(scope$, signal);
  });
  const starting$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = get(current$);
    if (
      current.phase === "suspended" ||
      current.signal.aborted ||
      !get(alive$) ||
      get(intent$).paused
    ) {
      throw new DOMException("Cancelled", "AbortError");
    }
    set(current$, { ...current, phase: "capturing" });
  });
  return { presenting$, scope$, replace$, starting$, cancel$ };
}

interface PresentationNodes {
  readonly attached: AttachedSelection;
  readonly scope: ReturnType<typeof createPresentationScope>;
  readonly invalidatePicture$: Command<void, []>;
  readonly input: ReturnType<typeof createInputSession>;
  readonly stream: ReturnType<typeof createScreencast>;
  readonly geometry: ReturnType<typeof createDisplayViewport>;
  readonly prepareRetry$: Command<Promise<void>, [AbortSignal]>;
}
type WaitForDisplay = Command<Promise<void>, [AbortSignal]> | null;

export function createSelectedPresentation(nodes: PresentationNodes) {
  const { attached, scope, invalidatePicture$, input, stream, geometry } =
    nodes;
  const receipt$ = state<Promise<PromiseSettledResult<void>> | null>(null);
  const release$ = command(
    async (
      { set },
      waitForDisplay$: WaitForDisplay,
      signal: AbortSignal,
    ): Promise<PromiseSettledResult<void>> => {
      const results = await Promise.allSettled([
        set(input.suspend$, attached.client.signal),
        set(stream.quiesce$, attached.frames.signal),
        ...(waitForDisplay$
          ? [set(waitForDisplay$, attached.client.signal)]
          : []),
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
    set(scope.cancel$);
    set(invalidatePicture$);
    set(stream.pause$);
    set(geometry.suspendPresentation$);
    const completion = set(release$, waitForDisplay$, attached.client.signal);
    set(receipt$, completion);
    return completion;
  });
  const retry$ = command(
    async ({ set }, starting$: Command<void, []>, signal: AbortSignal) => {
      const operation = set(scope.scope$, signal);
      await set(stream.retry$, nodes.prepareRetry$, starting$, operation);
      signal.throwIfAborted();
      operation.throwIfAborted();
    },
  );
  const resume$ = command(async ({ get, set }, signal: AbortSignal) => {
    const operation = set(scope.scope$, signal);
    const receipt = get(receipt$);
    if (receipt) {
      const result = await receipt;
      signal.throwIfAborted();
      operation.throwIfAborted();
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    await set(retry$, geometry.resumePresentation$, operation);
    signal.throwIfAborted();
    operation.throwIfAborted();
  });
  const start$ = command(async ({ set }, signal: AbortSignal) => {
    const operation = set(scope.scope$, signal);
    await set(stream.start$, operation);
    signal.throwIfAborted();
    operation.throwIfAborted();
  });
  const configure$ = command(
    async ({ set }, settings: CaptureSettings, signal: AbortSignal) => {
      const operation = set(scope.scope$, signal);
      await set(stream.configure$, settings, operation);
      signal.throwIfAborted();
      operation.throwIfAborted();
    },
  );
  return { ...scope, pause$, resume$, retry$, start$, configure$ };
}
