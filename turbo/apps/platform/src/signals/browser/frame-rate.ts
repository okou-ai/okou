import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { monotonicNow } from "../../lib/time.ts";
import { pageSignal$ } from "../page-signal.ts";
import { onRef, setLoop } from "../utils.ts";
import { localPoint } from "./input/geometry.ts";
import type { ViewerCaptureOptions } from "./viewer/types.ts";

interface FrameRateSource {
  readonly owner: object | null;
  readonly targetId: string | null;
  readonly selection: object | null;
  readonly capture: ViewerCaptureOptions;
  readonly canvas: HTMLCanvasElement | null;
  readonly active: boolean;
}

export interface FrameRatePoint {
  readonly at: number;
  readonly value: number | null;
}

interface Collection {
  readonly mount: object;
  readonly source: FrameRateSource;
  readonly sampledAt: number;
  readonly paints: readonly number[];
}

interface Sample {
  readonly source: FrameRateSource;
  readonly at: number;
  readonly value: number | null;
  readonly history: readonly FrameRatePoint[];
  readonly ceiling: number;
  readonly lower: { readonly target: number; readonly since: number } | null;
}

const WINDOW_MS = 1000;
const HISTORY_MS = 30_000;
const SHRINK_DELAY_MS = 6000;

function sameScope(left: FrameRateSource, right: FrameRateSource): boolean {
  return (
    left.owner === right.owner &&
    left.targetId === right.targetId &&
    left.selection === right.selection &&
    left.capture === right.capture
  );
}

function appendSample(
  previous: Sample | null,
  source: FrameRateSource,
  at: number,
  value: number | null,
): Sample {
  const before =
    previous && sameScope(previous.source, source) ? previous : null;
  const history = (before?.history ?? []).filter((point) => {
    return point.at > at - HISTORY_MS;
  });
  // A delayed timer cannot describe the skipped interval.
  if (before && at - before.at > WINDOW_MS * 1.5) {
    history.push({ at: at - WINDOW_MS, value: null });
  }
  history.push({ at, value });
  const peak = Math.max(
    0,
    ...history.map((point) => {
      return point.value ?? 0;
    }),
  );
  const target = Math.max(20, Math.ceil((peak * 1.2) / 10) * 10);
  let ceiling = before?.ceiling ?? target;
  let lower = before?.lower ?? null;
  if (target >= ceiling) {
    ceiling = target;
    lower = null;
  } else if (lower?.target !== target) {
    lower = { target, since: at };
  } else if (at - lower.since >= SHRINK_DELAY_MS) {
    ceiling = target;
    lower = null;
  }
  return { source, at, value, history, ceiling, lower };
}

function createPositionSignals(
  source$: Computed<FrameRateSource>,
  enabled$: Computed<boolean>,
) {
  const positionState$ = state({ x: 0, y: 0 });
  const raster$ = state<{
    width: number;
    height: number;
  } | null>(null);
  const position$ = computed((get) => {
    return get(positionState$);
  });
  const syncPosition$ = command(({ get, set }) => {
    const canvas = get(source$).canvas;
    if (!get(enabled$) || !canvas) {
      return;
    }
    const next = localPoint(canvas, { x: 0, y: 0 });
    const before = get(positionState$);
    if (next.x !== before.x || next.y !== before.y) {
      set(positionState$, next);
    }
  });
  const painted$ = command(({ get, set }) => {
    const canvas = get(source$).canvas;
    const before = get(raster$);
    if (
      canvas &&
      (before?.width !== canvas.width || before.height !== canvas.height)
    ) {
      set(raster$, { width: canvas.width, height: canvas.height });
      set(syncPosition$);
    }
  });
  const mount$ = command(({ set }, signal: AbortSignal) => {
    const sync = () => {
      set(syncPosition$);
    };
    window.addEventListener("resize", sync, { signal });
    window.visualViewport?.addEventListener("resize", sync, { signal });
    sync();
  });
  return { position$, syncPosition$, painted$, mount$ };
}

function createSamplingRef(
  source$: Computed<FrameRateSource>,
  enabled$: Computed<boolean>,
  collection$: State<Collection | null>,
  sample$: State<Sample | null>,
  mountPosition$: Command<void, [AbortSignal]>,
) {
  return onRef(
    command(({ get, set }, _node: HTMLDivElement, mountSignal: AbortSignal) => {
      const signal = AbortSignal.any([mountSignal, get(pageSignal$)]);
      signal.throwIfAborted();
      const mount = {};
      set(collection$, {
        mount,
        source: get(source$),
        sampledAt: monotonicNow(),
        paints: [],
      });
      set(
        sample$,
        appendSample(get(sample$), get(source$), monotonicNow(), null),
      );
      set(mountPosition$, signal);
      signal.addEventListener(
        "abort",
        () => {
          if (get(collection$)?.mount !== mount) {
            return;
          }
          set(collection$, null);
          const sample = get(sample$);
          const source = get(source$);
          if (get(enabled$) && sample && sameScope(sample.source, source)) {
            set(sample$, appendSample(sample, source, monotonicNow(), null));
          } else {
            set(sample$, null);
          }
        },
        { once: true },
      );
      setLoop(
        () => {
          const source = get(source$);
          const collection = get(collection$);
          if (!get(enabled$) || !source.active || collection?.mount !== mount) {
            return true;
          }
          const at = monotonicNow();
          if (!sameScope(collection.source, source)) {
            set(collection$, { mount, source, sampledAt: at, paints: [] });
            return false;
          }
          if (at - collection.sampledAt < WINDOW_MS) {
            return false;
          }
          const paints = collection.paints.filter((paint) => {
            return paint > at - WINDOW_MS;
          });
          set(collection$, { ...collection, sampledAt: at, paints });
          set(sample$, appendSample(get(sample$), source, at, paints.length));
          return false;
        },
        WINDOW_MS,
        signal,
        { testIntervalMs: 10 },
      );
    }),
  );
}

/** Accepted paints stay private; only the owner-paced sample reaches React. */
export function createFrameRateSignals(source$: Computed<FrameRateSource>) {
  const enabledState$ = state(false);
  const collection$ = state<Collection | null>(null);
  const sample$ = state<Sample | null>(null);
  const enabled$ = computed((get) => {
    return get(enabledState$);
  });
  const changeEnabled$ = command(({ get, set }, enabled: boolean) => {
    if (get(enabledState$) !== enabled) {
      set(enabledState$, enabled);
      set(collection$, null);
      set(sample$, null);
    }
  });
  const position = createPositionSignals(source$, enabled$);
  const snapshot$ = computed((get) => {
    const source = get(source$);
    const active = get(enabled$) && source.active;
    const published = get(sample$);
    const sample =
      published && sameScope(published.source, source) ? published : null;
    return {
      active,
      value: active ? (sample?.value ?? null) : null,
      at: sample?.at ?? 0,
      history: sample?.history ?? [],
      ceiling: sample?.ceiling ?? 20,
    };
  });
  const recordPaint$ = command(
    ({ get, set }, owner: object, targetId: string) => {
      if (!get(enabled$)) {
        return;
      }
      const source = get(source$);
      const collection = get(collection$);
      if (
        !source.active ||
        source.owner !== owner ||
        source.targetId !== targetId ||
        !collection
      ) {
        return;
      }
      set(position.painted$);
      const at = monotonicNow();
      const current = sameScope(collection.source, source)
        ? collection
        : { mount: collection.mount, source, sampledAt: at, paints: [] };
      set(collection$, {
        ...current,
        paints: [
          ...current.paints.filter((paint) => {
            return paint > at - WINDOW_MS;
          }),
          at,
        ],
      });
    },
  );
  const ref$ = createSamplingRef(
    source$,
    enabled$,
    collection$,
    sample$,
    position.mount$,
  );
  return {
    enabled$,
    changeEnabled$,
    snapshot$,
    position$: position.position$,
    syncPosition$: position.syncPosition$,
    ref$,
    recordPaint$,
  };
}

export type FrameRateSignals = ReturnType<typeof createFrameRateSignals>;
