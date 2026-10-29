import { expect, test } from "vitest";
import {
  transitionImage,
  type ImageEvent,
  type ImageRecovery,
} from "../viewer/image-recovery.ts";

const owner = Object.freeze({});
const error = Object.freeze({
  kind: "frame",
  message: "Synthetic capture failure",
} as const);
const failed: ImageEvent = Object.freeze({
  type: "image-failed",
  owner,
  targetId: "page-a",
  error,
});
const settled: ImageEvent = Object.freeze({
  type: "image-settled",
  owner,
  ready: true,
});
const retry: ImageEvent = Object.freeze({ type: "image-retrying", owner });
const starting: ImageEvent = Object.freeze({ type: "image-starting", owner });
const paint: ImageEvent = Object.freeze({ type: "image-painted", owner });
const released: ImageEvent = Object.freeze({ type: "image-released", owner });

function after(events: readonly ImageEvent[]): ImageRecovery | null {
  let image: ImageRecovery | null = null;
  for (const event of [failed, ...events]) {
    image = transitionImage(image, event).state;
  }
  return image;
}

test.each([
  [paint, released],
  [released, paint],
])(
  "joins current paint and lane release in either order: %j",
  (first, last) => {
    let image = after([settled, retry, starting]);
    const early = transitionImage(image, first);
    expect(early.accepted).toBeTruthy();
    expect(early.imageReady).toBe(first === paint);
    expect(early.resumeDisplay).toBeFalsy();
    image = early.state;
    const complete = transitionImage(image, last);
    expect(complete.state).toBeNull();
    expect(complete.imageReady).toBe(last === paint);
    expect(complete.resumeDisplay).toBeTruthy();
    for (const late of [first, last, settled, retry]) {
      const decision = transitionImage(complete.state, late);
      expect(decision.accepted).toBeFalsy();
      expect(decision.resumeDisplay).toBeFalsy();
    }
  },
);

test.each([true, false])(
  "cancellation reports original native stop certainty: stopped=%s",
  (stopped) => {
    const image = after([settled, retry, starting]);
    const cancelled = transitionImage(image, {
      type: "image-cancelled",
      owner,
      stopped,
    });
    expect(cancelled.state?.phase).toBe(stopped ? "ready" : "blocked");
    expect(transitionImage(cancelled.state, retry).accepted).toBe(stopped);
    for (const late of [paint, released, settled]) {
      expect(transitionImage(cancelled.state, late).state).toBe(
        cancelled.state,
      );
    }
  },
);

test("does not substitute a stopped capture for still-pending input/display cleanup", () => {
  const image = after([]);
  const cancelled = transitionImage(image, {
    type: "image-cancelled",
    owner,
    stopped: true,
  });
  expect(cancelled.state).toBe(image);
  expect(transitionImage(cancelled.state, retry).accepted).toBeFalsy();
  expect(transitionImage(cancelled.state, settled).state?.phase).toBe("ready");
});

test("rejects obsolete owners and late cleanup without rewinding a running attempt", () => {
  const image = after([settled, retry]);
  for (const event of [settled, paint, released, starting]) {
    const obsolete = { ...event, owner: {} };
    expect(transitionImage(image, obsolete).state).toBe(image);
  }
  expect(transitionImage(image, settled).state).toBe(image);
  expect(transitionImage(image, retry).state).toBe(image);
});

test("preserves cleanup, start, paint and lane invariants across bounded event sequences", () => {
  const events: readonly ImageEvent[] = [
    settled,
    { type: "image-settled", owner, ready: false },
    retry,
    starting,
    paint,
    released,
    { type: "image-cancelled", owner, stopped: true },
    { type: "image-cancelled", owner, stopped: false },
    { type: "image-blocked", owner, error },
  ];
  interface Facts {
    stopped: boolean;
    intent: boolean;
    started: boolean;
    painted: boolean;
    released: boolean;
    resumed: boolean;
  }
  let inspected = 0;
  function verifyPresentation(
    next: ReturnType<typeof transitionImage>,
    observed: Facts,
    assertInvariant: (valid: boolean) => void,
  ): void {
    if (next.imageReady) {
      assertInvariant(observed.intent && observed.painted);
    }
    if (next.resumeDisplay) {
      assertInvariant(
        observed.intent &&
          observed.painted &&
          observed.released &&
          !observed.resumed,
      );
      observed.resumed = true;
    }
  }
  function visit(
    image: ImageRecovery | null,
    facts: Facts,
    depth: number,
    trace: readonly string[],
  ) {
    if (!depth) {
      return;
    }
    for (const event of events) {
      inspected++;
      const next = transitionImage(image, event);
      const observed = { ...facts };
      const path = [...trace, event.type];
      const assertInvariant = (valid: boolean) => {
        if (!valid) {
          throw new Error("Lifecycle invariant: " + path.join(" -> "));
        }
      };
      if (!next.accepted) {
        assertInvariant(
          next.state === image && !next.imageReady && !next.resumeDisplay,
        );
      } else {
        if (event.type === "image-settled") {
          observed.stopped = event.ready;
        }
        if (event.type === "image-retrying") {
          assertInvariant(observed.stopped);
          observed.intent = true;
          observed.started = false;
          observed.painted = false;
          observed.released = false;
          observed.resumed = false;
        }
        if (event.type === "image-starting") {
          assertInvariant(observed.intent && observed.stopped);
          observed.stopped = false;
          observed.started = true;
        }
        if (event.type === "image-painted") {
          assertInvariant(observed.intent && observed.started);
          observed.painted = true;
        }
        if (event.type === "image-released") {
          assertInvariant(observed.intent && observed.started);
          observed.released = true;
        }
        if (event.type === "image-cancelled") {
          observed.stopped = event.stopped;
          observed.intent = false;
          observed.painted = false;
          observed.released = false;
        }
        verifyPresentation(next, observed, assertInvariant);
      }
      visit(next.state, observed, depth - 1, path);
    }
  }
  const prefixes = [
    [],
    [settled],
    [settled, retry, starting],
    [settled, retry, starting, paint],
    [settled, retry, starting, released],
  ];
  for (const prefix of prefixes) {
    visit(
      after(prefix),
      {
        stopped: prefix.includes(settled) && !prefix.includes(starting),
        intent: prefix.includes(retry),
        started: prefix.includes(starting),
        painted: prefix.includes(paint),
        released: prefix.includes(released),
        resumed: false,
      },
      4,
      prefix.map((event) => {
        return event.type;
      }),
    );
  }
  expect(inspected).toBe(36_900);
});
