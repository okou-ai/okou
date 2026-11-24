import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, test } from "vitest";

const exec = promisify(execFile);
const bundle = process.env.REPLAY_BUNDLE;
const checkout = process.env.REPLAY_CHECKOUT;
const shuffled = process.env.REPLAY_SHUFFLE === "1";

async function replay(group, scenarios) {
  const jobs = shuffled ? [...scenarios].reverse() : scenarios;
  const args = group === "topics" ? ["custom", ...jobs] : jobs;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
  );
  env.NODE_ENV = "development";
  const { stdout } = await exec(
    "bash",
    [join(bundle, group, "replay.sh"), ...args],
    {
      cwd: checkout,
      env,
      timeout: 480_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const directory = stdout.match(/^Receipts directory (.+)$/m)?.[1];
  assert.ok(directory, "The browser runner must identify its new receipts");
  console.info(group, directory);
  return async (name) =>
    JSON.parse(await readFile(join(directory, name), "utf8"));
}

function readRequests(wire) {
  return wire.filter(
    (event) =>
      event.t === "get-computed" && event.key === "chat-thread-indicators",
  );
}

function replyFor(wire, request, type) {
  return wire.find((event) => event.i === request.i && event.t === type);
}

function registered(stages) {
  const peers = stages[0].events.filter((event) => event.op === "peer-open");
  assert.deepEqual(
    peers.map((event) => event.number),
    ["1", "2"],
  );
  assert.equal(peers[0].worker, peers[1].worker);
  return peers[0].worker;
}

describe("Signed-in Router windows on one native SharedWorker", () => {
  let load;
  beforeAll(async () => {
    load = await replay("windows", ["023", "020", "027"]);
  }, 490_000);

  test("message-port-023 The same pending indicators read returns the named aggregate to both callers", async () => {
    const stages = await load("windows-023.json");
    registered(stages);
    const [, pending, released, control] = stages;
    assert.ok(pending.both && released.returned && control.recovered);
    assert.ok(
      pending.events.some(
        (e) => e.op === "settled" && e.alias === "A" && e.status === 503,
      ),
    );
    assert.ok(
      pending.events.some(
        (e) => e.op === "asked" && e.alias === "B" && e.mode === "hold-fail",
      ),
    );
    assert.ok(
      released.events.some(
        (e) => e.op === "settled" && e.alias === "B" && e.status === 503,
      ),
    );
    const publications = [...pending.events, ...released.events].filter(
      (e) => e.op === "published" && e.topic === "chatIndicatorsChanged",
    );
    assert.equal(publications.length, 1);
    for (const window of ["A", "B"]) {
      const request = readRequests(pending.wire[window])[0];
      assert.ok(request, window);
      assert.equal(replyFor(pending.wire[window], request, "error"), undefined);
      assert.equal(
        replyFor(pending.wire[window], request, "result"),
        undefined,
      );
      const error = replyFor(released.wire[window], request, "error");
      assert.equal(error?.error, "AggregateError");
      assert.deepEqual(error.shape, ["message", "name"]);
      assert.ok(
        released.errors.some(
          (e) =>
            e.alias === window &&
            e.port &&
            e.name === "AggregateError" &&
            e.type === "Error" &&
            !e.aggregate,
        ),
      );
    }
    assert.ok(
      control.events.some((e) => e.op === "indicators" && e.alias === "B"),
    );
  });

  test("message-port-020 The second window issues its read and supplies the successful credential while the first waits", async () => {
    const stages = await load("windows-020.json");
    registered(stages);
    const [, asked, returned] = stages;
    assert.ok(asked.both && returned.returned);
    const { A, B } = returned.wire;
    const pending = A.find(
      (e) =>
        e.t === "get-token" &&
        !replyFor(A, e, "token-result") &&
        !replyFor(A, e, "token-error"),
    );
    assert.ok(pending);
    const owner = readRequests(B).find(
      (r) => r.time > pending.time && replyFor(B, r, "result")?.unreadSide,
    );
    assert.ok(
      owner,
      "B must issue its own indicators request after A was asked",
    );
    assert.ok(
      B.some((e) => e.t === "get-token" && replyFor(B, e, "token-result")),
    );
    const events = [...asked.events, ...returned.events];
    assert.ok(
      events.some(
        (e) => e.op === "settled" && e.alias === "B" && e.mode === "ready",
      ),
    );
    assert.ok(events.some((e) => e.op === "indicators" && e.alias === "B"));
  });

  test("message-port-027 A released account port closes and the surviving registered window receives its empty offline query", async () => {
    const stages = await load("windows-027.json");
    const worker = registered(stages);
    const { events, wire } = stages[1];
    const original = events.filter(
      (e) => e.worker === worker && e.number === "1",
    );
    assert.ok(original.some((e) => e.op === "peer-disconnect"));
    assert.ok(
      original.some(
        (e) => e.op === "peer-closed-by-worker" || e.op === "peer-close",
      ),
    );
    assert.ok(
      !events.some(
        (e) =>
          e.worker === worker && e.number === "2" && e.op.includes("close"),
      ),
    );
    const request = wire.B.find(
      (e) =>
        e.t === "query" &&
        e.key === "chat-event" &&
        e.consistency === "cache-only",
    );
    assert.ok(request);
    assert.equal(replyFor(wire.B, request, "result")?.rows, 0);
  });
});

function automationSubscriptions(ports) {
  return ports.filter(
    (p) =>
      p.type === "realtime-subscribe" &&
      p.scope === "user" &&
      p.topic.startsWith("chatThreadAutomationsChanged:b000"),
  );
}

describe("Thread notifications at the external provider and original native ports", () => {
  let load;
  beforeAll(async () => {
    load = await replay("topics", ["014", "route038", "exact033"]);
  }, 490_000);

  test("message-port-014 Each original subscriber receives its own resync and the last release ends the shared topic", async () => {
    const { stages, ports, receivers } = await load("verified-014.json");
    const original = automationSubscriptions(ports);
    assert.deepEqual(original.map((p) => p.alias).sort(), ["A", "B"]);
    for (const sub of original) {
      const received = ports.filter(
        (p) =>
          p.subscription === sub.subscription && p.direction === "received",
      );
      assert.deepEqual(
        received.filter((p) => p.type === "realtime-event").map((p) => p.step),
        sub.alias === "A" ? [0] : [0, 4],
      );
      assert.deepEqual(
        received.filter((p) => p.type === "realtime-resync").map((p) => p.step),
        [3],
      );
    }
    assert.equal(stages[2].label, "resume");
    assert.equal(stages[3].label, "gap");
    assert.deepEqual(
      stages[4].reads.filter((e) => e.op === "automations").map((e) => e.alias),
      ["B"],
    );
    const topic = receivers.filter(
      (e) =>
        e.name === "user:fixture" &&
        e.topic === "chatThreadAutomationsChanged:thread",
    );
    assert.deepEqual(
      topic
        .filter((e) =>
          ["subscribe", "delivery-1", "unsubscribe"].includes(e.op),
        )
        .map((e) => e.op),
      ["subscribe", "delivery-1", "delivery-1", "unsubscribe"],
    );
  });

  test("message-port-033 The registered tab reloads indicators three times before two messages advance its offline history", async () => {
    const { ports, stages } = await load("verified-exact033.json");
    const reloads = ports.filter(
      (p) =>
        p.type === "reload-computed" &&
        p.key === "chat-thread-indicators" &&
        [1, 2].includes(p.step),
    );
    assert.equal(reloads.length, 3);
    const reads = stages
      .slice(1, 5)
      .map((stage) => stage.wire.filter((e) => e.op === "catchUp"));
    assert.deepEqual(
      reads.map((r) => r.length),
      [0, 0, 1, 1],
    );
    assert.deepEqual(
      reads
        .slice(2)
        .map(([e]) => e.threads.find((t) => t.source === "primary")?.returned),
      [0, 1],
    );
    assert.equal(stages.at(-1).label, "both original and new event offline");
  });

  test("message-port-038 Both waiting ports receive the attach failure and the reacquired subscription delivers to its new owner", async () => {
    const { ports, receivers } = await load("verified-route038.json");
    const subscriptions = automationSubscriptions(ports);
    const original = subscriptions.filter((p) => p.step === 0);
    assert.deepEqual(original.map((p) => p.alias).sort(), ["A", "B"]);
    for (const old of original) {
      const replies = ports.filter(
        (p) =>
          p.direction === "received" && p.subscription === old.subscription,
      );
      assert.deepEqual(
        replies.map((p) => [p.type, p.error, p.attachFailure]),
        [["realtime-subscription-error", "Error", true]],
      );
    }
    assert.ok(
      receivers.some(
        (e) =>
          e.op === "delivery-0" &&
          e.topic === "chatThreadAutomationsChanged:thread",
      ),
    );
    const [fresh] = subscriptions.filter(
      (p) => p.step === 2 && p.alias === "B",
    );
    assert.ok(
      fresh && original.every((p) => p.subscription !== fresh.subscription),
    );
    assert.deepEqual(
      ports
        .filter(
          (p) =>
            p.direction === "received" && p.subscription === fresh.subscription,
        )
        .map((p) => p.type),
      ["realtime-subscribed", "realtime-event"],
    );
  });
});

test("client-006 Equal page session IDs on separate connections deliver only the originating viewer's native events", async () => {
  const load = await replay("viewer", []);
  const state = await load("client006.json");
  const { after, before, inlet, headland, survivorBeforeOwnEvent } = state;
  assert.deepEqual(inlet, [before[0] + "#inlet", before[1]]);
  assert.deepEqual(headland, [before[0] + "#headland", before[1]]);
  assert.equal(survivorBeforeOwnEvent, before[1]);
  const first = after.wire.filter((e) =>
    ["#inlet", "#headland"].includes(new URL(e.url).hash),
  );
  const surviving = after.wire.find((e) => new URL(e.url).hash === "#survivor");
  assert.equal(first.length, 2);
  for (const e of first) {
    assert.equal(e.session, surviving.session);
    assert.notEqual(e.socketId, surviving.socketId);
    assert.ok(after.closes.includes(e.socketId));
  }
  assert.ok(after.originalPageEvents.includes("#after-close"));
  assert.ok(!after.wire.some((e) => new URL(e.url).hash === "#after-close"));
  assert.equal(after.survivor, before[1] + "#survivor");
}, 490_000);
