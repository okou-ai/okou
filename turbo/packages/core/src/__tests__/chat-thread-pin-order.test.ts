import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comparePinnedThreads,
  firstChatThreadPinOrder,
  isChatThreadPinOrder,
  moveChatThreadPinOrder,
  type PinnedThreadOrder,
} from "../chat-thread-pin-order";
import {
  replayChatThreadEvents,
  type ReplayChatThreadEvent,
} from "../chat-thread-event-replay";
import type { ChatThreadSnapshotProjection } from "@okouai/api-contracts/contracts/chat-threads";

function pin(id: string, pinOrder?: string): PinnedThreadOrder {
  return { id, pinOrder, pinnedAt: "2026-09-01T00:00:00.000Z" };
}
function moved(
  threads: PinnedThreadOrder[],
  id: string,
  target: string,
  side: "before" | "after",
) {
  const updates = moveChatThreadPinOrder(threads, id, target, side);
  return threads
    .map((thread) => {
      return {
        ...thread,
        pinOrder:
          updates.find((update) => {
            return update.threadId === thread.id;
          })?.pinOrder ?? thread.pinOrder,
      };
    })
    .sort(comparePinnedThreads);
}

describe("pinned thread fractional ordering", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["UTC", "Asia/Shanghai", "America/New_York"])(
    "assigns the same legacy rank to event and SQL timestamps in %s",
    (timezone) => {
      vi.stubEnv("TZ", timezone);
      const timestamp = "2026-09-01T00:00:00.000";
      const snapshotPin = { ...pin("a"), pinnedAt: timestamp };
      const eventPin = { ...pin("a"), pinnedAt: `${timestamp}Z` };
      expect(firstChatThreadPinOrder([snapshotPin])).toBe(
        firstChatThreadPinOrder([eventPin]),
      );
    },
  );
  it("preserves historical pin time and ID order, and inserts new pins first", () => {
    const old = pin("old");
    const newer = { ...pin("newer"), pinnedAt: "2026-09-02T00:00:00.000Z" };
    const threads = [old, newer];
    const first = pin("first", firstChatThreadPinOrder(threads));
    expect(
      [...threads, first].sort(comparePinnedThreads).map((item) => {
        return item.id;
      }),
    ).toStrictEqual(["first", "newer", "old"]);
    expect(
      [pin("a", "a0"), pin("b", "a0")]
        .sort(comparePinnedThreads)
        .map((item) => {
          return item.id;
        }),
    ).toStrictEqual(["b", "a"]);
  });

  it("uses byte order across upper and lower case rank digits", () => {
    expect(
      [pin("lower", "a0a"), pin("upper", "a0Z")]
        .sort(comparePinnedThreads)
        .map((item) => {
          return item.id;
        }),
    ).toStrictEqual(["upper", "lower"]);
  });

  it("inserts at either end and in the middle without rewriting neighbors", () => {
    const threads = [pin("a", "a0"), pin("b", "a1"), pin("c", "a2")];
    expect(
      moved(threads, "c", "a", "after").map((item) => {
        return item.id;
      }),
    ).toStrictEqual(["a", "c", "b"]);
    expect(
      moved(threads, "c", "a", "before").map((item) => {
        return item.id;
      }),
    ).toStrictEqual(["c", "a", "b"]);
    expect(
      moved(threads, "a", "c", "after").map((item) => {
        return item.id;
      }),
    ).toStrictEqual(["b", "c", "a"]);
    expect(moveChatThreadPinOrder(threads, "c", "a", "after")).toHaveLength(1);
    expect(moveChatThreadPinOrder(threads, "b", "a", "after")).toStrictEqual(
      [],
    );
  });

  it("opens a zero-width gap by moving only the tied suffix", () => {
    const threads = [
      pin("z", "a0"),
      pin("y", "a0"),
      pin("x", "a0"),
      pin("next", "a1"),
      pin("moved", "a2"),
    ];
    const result = moved(threads, "moved", "y", "before");
    expect(
      result.map((item) => {
        return item.id;
      }),
    ).toStrictEqual(["z", "moved", "y", "x", "next"]);
    expect(result[0]?.pinOrder).toBe("a0");
    expect(result.at(-1)?.pinOrder).toBe("a1");
    expect(
      moved(
        threads.slice(0, 3).concat(pin("moved", "a1")),
        "moved",
        "y",
        "before",
      ).map((item) => {
        return item.id;
      }),
    ).toStrictEqual(["z", "moved", "y", "x"]);
  });

  it("supports repeated insertion without floating point exhaustion", () => {
    let threads = [pin("a", "a0"), pin("b", "a1"), pin("c", "a2")];
    for (let i = 0; i < 500; i++) {
      threads = moved(threads, i % 2 === 0 ? "c" : "b", "a", "after");
    }
    expect(
      threads.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual(["a", "b", "c"]);
    expect(
      threads.every((thread) => {
        return isChatThreadPinOrder(thread.pinOrder!);
      }),
    ).toBeTruthy();
  });

  it.each(["", "a", "a00", "b0", "a0!", "0a", "A00000000000000000000000000"])(
    "rejects invalid rank %s",
    (rank) => {
      expect(isChatThreadPinOrder(rank)).toBeFalsy();
    },
  );
});

it("replays rank events without touching activity, pin time, or an unpinned thread", () => {
  const snapshot: ChatThreadSnapshotProjection = {
    id: "thread",
    agentId: "agent",
    title: "Original",
    sortAt: "2026-09-01T01:00:00Z",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    pinnedAt: "2026-09-01T00:00:00Z",
    archived: false,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    selectedVideoModel: null,
  };
  const event: ReplayChatThreadEvent = {
    id: "event",
    kind: "sort_touched",
    chatThreadId: "thread",
    agentId: "agent",
    title: null,
    pinOrder: "a0",
    createdAt: "2026-09-05T00:00:00Z",
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    selectedVideoModel: null,
  };
  const [ranked] = replayChatThreadEvents([snapshot], [event]);
  expect(ranked).toMatchObject({ ...snapshot, pinOrder: "a0" });
  const [unpinned] = replayChatThreadEvents(
    [snapshot],
    [{ ...event, kind: "unpinned" }, event],
  );
  expect(unpinned).toMatchObject({
    pinnedAt: null,
    pinOrder: null,
    sortAt: snapshot.sortAt,
  });
  const [repinned] = replayChatThreadEvents(
    [snapshot],
    [
      { ...event, kind: "unpinned" },
      { ...event, kind: "pinned", pinOrder: "Zz" },
    ],
  );
  expect(repinned).toMatchObject({ pinOrder: "Zz", pinnedAt: event.createdAt });
});
