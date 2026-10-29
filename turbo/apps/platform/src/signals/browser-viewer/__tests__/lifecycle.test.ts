import { sequences as eventSequences } from "./sequences.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { expect, test } from "vitest";
import {
  initialIntent,
  transitionIntent,
  type IntentEvent,
} from "../viewer/lifecycle.ts";

import { createViewerSignals, type ViewerTransition } from "../viewer/model.ts";

const context = testContext();

test("keeps no-op pause identity and gives deliberate reselection a new intent", () => {
  const initial = initialIntent();
  expect(transitionIntent(initial, { type: "pause", paused: false })).toBe(
    initial,
  );
  const selected = transitionIntent(initial, {
    type: "select",
    targetId: "page-a",
    paused: false,
  });
  expect(
    transitionIntent(selected, {
      type: "select",
      targetId: "page-a",
      paused: false,
    }),
  ).not.toBe(selected);
  const paused = transitionIntent(selected, { type: "pause", paused: true });
  expect(paused).toMatchObject({ paused: true, targetId: "page-a" });
  expect(transitionIntent(selected, { type: "target-lost" }).selection).toBe(
    selected.selection,
  );
  expect(
    transitionIntent(selected, {
      type: "select",
      targetId: "page-a",
      paused: false,
    }).selection,
  ).not.toBe(selected.selection);
  expect(transitionIntent(paused, { type: "reset" })).toMatchObject({
    paused: true,
    targetId: null,
  });
});

test("returns the originating committed intent when publication synchronously replaces it", () => {
  const model = createViewerSignals();
  let replace = true;
  const stop = context.store.watch(model.intent$, () => {
    if (replace && context.store.get(model.intent$).targetId === "page-a") {
      replace = false;
      context.store.set(model.commitIntent$, { type: "pause", paused: true });
    }
  });
  const origin = context.store.set(model.commitIntent$, {
    type: "select",
    targetId: "page-a",
    paused: false,
  });
  stop();
  expect(origin.paused).toBeFalsy();
  expect(context.store.get(model.intent$)).not.toBe(origin);
  expect(context.store.get(model.intent$).paused).toBeTruthy();
  expect(context.store.get(model.snapshot$).status).toBe("paused");
});

test("preserves latest parent intent across bounded parent and image outcome sequences", () => {
  const owner = {};
  const error = { kind: "frame", message: "Synthetic image failure" } as const;
  const events: readonly ViewerTransition[] = [
    { type: "pause", paused: true },
    { type: "pause", paused: false },
    { type: "streaming" },
    { type: "select", targetId: "page-b", paused: false },
    { type: "target-lost", error: null },
    {
      type: "disconnected",
      established: true,
      error: { kind: "connection", message: "Synthetic loss" },
    },
    { type: "image-settled", owner, ready: true },
    { type: "image-retrying", owner },
    { type: "image-starting", owner },
    { type: "image-painted", owner },
    { type: "image-released", owner },
    { type: "image-cancelled", owner, stopped: true },
  ];
  let sequences = 0;
  for (const sequence of eventSequences(events, 3)) {
    const model = createViewerSignals();
    context.store.set(model.transition$, {
      type: "select",
      targetId: "page-a",
      paused: false,
    });
    context.store.set(model.transition$, {
      type: "image-failed",
      owner,
      targetId: "page-a",
      error,
    });
    let paused = false;
    let target: string | null = "page-a";
    for (const event of sequence) {
      if (event.type === "pause") {
        paused = event.paused;
      }
      if (event.type === "select") {
        paused = event.paused;
        target = event.targetId;
      }
      if (event.type === "target-lost") {
        target = null;
      }
      context.store.set(model.transition$, event);
      expect(context.store.get(model.intent$).paused).toBe(paused);
      expect(context.store.get(model.intent$).targetId).toBe(target);
      expect(context.store.get(model.snapshot$).selectedTargetId).toBe(target);
      const status = context.store.get(model.snapshot$).status;
      const expectedStatus =
        paused && target && status !== "disconnected" ? "paused" : status;
      expect(status).toBe(expectedStatus);
      expect(
        paused && context.store.get(model.controls$).canRetryImage,
      ).toBeFalsy();
    }
    sequences++;
  }
  expect(sequences).toBe(1728);
});

test("keeps original intent values immutable across retirement facts", () => {
  const original = transitionIntent(initialIntent(), {
    type: "select",
    targetId: "page-a",
    paused: false,
  });
  const events: readonly IntentEvent[] = [
    { type: "pause", paused: true },
    { type: "invalidate" },
    { type: "target-lost" },
    { type: "discovery-failed" },
  ];
  for (const event of events) {
    transitionIntent(original, event);
  }
  expect(original).toMatchObject({ targetId: "page-a", paused: false });
  expect(Object.isFrozen(original)).toBeTruthy();
});
