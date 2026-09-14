import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createSessionOutputStream } from "../session-output-stream";

const context = testContext();
const target = Object.freeze({
  userId: "owner",
  orgId: "org",
  threadId: "b0000000-0000-4000-a000-000000000801",
  runId: "d0000000-0000-4000-a000-000000000851",
});

// External SDK boundary: observe occupancy and publications without persisting
// transient text or involving a provider call in the durable event pipeline.
test("skips publication without viewers and preserves a late block's nonzero index", async () => {
  let occupancy: ((message: { data: unknown }) => void) | undefined;
  context.mocks.ably.realtimeSubscribe.mockImplementation((_name, listener) => {
    occupancy = listener;
    return Promise.resolve();
  });
  const stream = createSessionOutputStream(target, context.signal);
  const runEventId = `${stream.eventIdPrefix}:2`;
  stream.onDelta({ runEventId, chunkIndex: 0, delta: "Missed start" });
  expect(context.mocks.ably.realtimePublish).not.toHaveBeenCalled();
  occupancy?.({ data: { metrics: { subscribers: 1 } } });
  stream.onDelta({ runEventId, chunkIndex: 1, delta: "Later text" });
  stream.close();
  await flushWaitUntilForTest();
  expect(context.mocks.ably.realtimePublish).toHaveBeenCalledWith(
    `run-output:owner:org:${target.runId}`,
    { modes: ["PUBLISH"], params: { occupancy: "metrics.subscribers" } },
    target.runId,
    expect.objectContaining({
      runEventId,
      chunkIndex: 1,
      delta: "Later text",
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    }),
  );
  expect(context.mocks.ably.realtimeClose).toHaveBeenCalledWith();
});

test("a stream transport failure leaves the run caller and cleanup successful", async () => {
  context.mocks.ably.realtimeSubscribe.mockImplementation((_name, listener) => {
    listener({ data: { metrics: { subscribers: 1 } } });
    return Promise.resolve();
  });
  context.mocks.ably.realtimePublish.mockRejectedValue(
    new Error("transport unavailable"),
  );
  const stream = createSessionOutputStream(target, context.signal);
  expect(() => {
    stream.onDelta({
      runEventId: `${stream.eventIdPrefix}:0`,
      chunkIndex: 0,
      delta: "Preview",
    });
  }).not.toThrow();
  stream.close();
  await flushWaitUntilForTest();
  expect(context.mocks.ably.realtimeClose).toHaveBeenCalledWith();
});
