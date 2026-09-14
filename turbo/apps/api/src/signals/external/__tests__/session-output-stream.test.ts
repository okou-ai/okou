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

// External SDK boundary: observe transient publications independently of the
// durable event pipeline.
test("publishes text immediately without a subscriber handshake", async () => {
  const stream = createSessionOutputStream(target, context.signal);
  const runEventId = `${stream.eventIdPrefix}:2`;
  stream.onDelta({ runEventId, chunkIndex: 0, delta: "First text" });
  stream.onDelta({ runEventId, chunkIndex: 1, delta: "Later text" });
  stream.close();
  await flushWaitUntilForTest();
  expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
    `run-output:owner:org:${target.runId}`,
  );
  expect(context.mocks.ably.publish).toHaveBeenNthCalledWith(
    1,
    target.runId,
    expect.objectContaining({
      runEventId,
      chunkIndex: 0,
      delta: "First text",
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    }),
  );
  expect(context.mocks.ably.publish).toHaveBeenNthCalledWith(
    2,
    target.runId,
    expect.objectContaining({
      runEventId,
      chunkIndex: 1,
      delta: "Later text",
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    }),
  );
  expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);
});

test("a stream transport failure leaves the run caller and cleanup successful", async () => {
  context.mocks.ably.publish.mockRejectedValue(
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
  expect(context.mocks.ably.publish).toHaveBeenCalledOnce();
});
