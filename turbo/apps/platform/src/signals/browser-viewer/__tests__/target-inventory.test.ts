import { expect, test } from "vitest";
import {
  currentObservation,
  currentRound,
  initialInventory,
  inventoryExpiry,
  inventoryTargets,
  transitionInventory,
  type InventoryEvent,
  type TargetObservation,
} from "../viewer/target-inventory.ts";

const page = Object.freeze({ id: "page", title: "Initial" });

function inventory() {
  let state = initialInventory();
  const send = (event: InventoryEvent) => {
    return (state = transitionInventory(state, event));
  };
  const observe = (id: string = page.id, startedAt = 0): TargetObservation => {
    send({ type: "order" });
    return {
      id,
      epoch: state.epoch,
      generation: state.entries.get(id)!.generation,
      order: state.sequence,
      startedAt,
    };
  };
  const round = send({ type: "begin-round", now: 0 }).round!;
  send({ type: "listed", round, targets: [page] });
  send({ type: "membership", observation: observe(), member: true });
  send({ type: "complete-round", round });
  return {
    read: () => {
      return state;
    },
    send,
    observe,
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  return items.length === 0
    ? [[]]
    : items.flatMap((item, index) => {
        return permutations(
          items.filter((_, other) => {
            return other !== index;
          }),
        ).map((tail) => {
          return [item, ...tail];
        });
      });
}

const traces = permutations([
  "title-one",
  "title-two",
  "older",
  "newer",
]).filter((trace) => {
  return trace.indexOf("title-one") < trace.indexOf("title-two");
});

test.each(
  traces.map((trace) => {
    return { trace };
  }),
)(
  "keeps title and scope observation order independent: $trace",
  ({ trace }) => {
    for (const member of [false, true]) {
      const h = inventory();
      const older = h.observe(page.id, 1);
      const newer = h.observe(page.id, 2);
      for (const event of trace) {
        if (event === "older" || event === "newer") {
          h.send({
            type: "membership",
            observation: event === "older" ? older : newer,
            member: event === "older" ? !member : member,
          });
        } else {
          h.send({
            type: "metadata",
            target: { ...page, title: event },
            now: 3,
          });
        }
      }
      expect(h.read().entries.get(page.id)?.target?.title).toBe("title-two");
      expect(inventoryTargets(h.read())).toStrictEqual(
        member ? [{ ...page, title: "title-two" }] : [],
      );
      expect(currentObservation(h.read(), older)).toBeFalsy();
    }
  },
);

test("merges a full result's scope without restoring its older title", () => {
  const h = inventory();
  const round = h.send({ type: "begin-round", now: 10 }).round!;
  h.send({ type: "metadata", target: { ...page, title: "Newer" }, now: 11 });
  h.send({ type: "listed", round, targets: [page] });
  h.send({
    type: "membership",
    observation: h.observe(page.id, 12),
    member: true,
  });
  h.send({ type: "complete-round", round });
  expect(inventoryTargets(h.read())).toStrictEqual([
    { ...page, title: "Newer" },
  ]);
});

test("rejects a destroyed unknown target from a held bootstrap", () => {
  let state = initialInventory();
  state = transitionInventory(state, { type: "begin-round", now: 0 });
  const round = state.round!;
  state = transitionInventory(state, { type: "retired", id: page.id });
  state = transitionInventory(state, {
    type: "listed",
    round,
    targets: [page],
  });
  state = transitionInventory(state, { type: "complete-round", round });
  expect(inventoryTargets(state)).toStrictEqual([]);
  expect(state.entries.size).toBe(0);
});

test.each(["birth", "metadata", "membership"])(
  "preserves newer %s evidence against a stale full omission",
  (kind) => {
    const h = inventory();
    const round = h.send({ type: "begin-round", now: 1 }).round!;
    const target =
      kind === "birth"
        ? { id: "new-page", title: "New" }
        : kind === "metadata"
          ? { ...page, title: "New" }
          : page;
    if (kind !== "membership") {
      h.send({ type: "metadata", target, now: 2 });
    }
    const proof = h.observe(target.id, 2);
    h.send({ type: "membership", observation: proof, member: true });
    h.send({ type: "listed", round, targets: kind === "birth" ? [page] : [] });
    h.send({ type: "complete-round", round });
    expect(inventoryTargets(h.read())).toContainEqual(target);
  },
);

test.each(["retired", "closed", "reset"] as const)(
  "does not transfer a proof through %s and a new lifetime",
  (type) => {
    const h = inventory();
    const old = h.observe();
    h.send(type === "reset" ? { type } : { type, id: page.id });
    h.send({
      type: "metadata",
      target: { ...page, title: "Replacement" },
      now: 1,
    });
    h.send({ type: "membership", observation: old, member: true });
    expect(currentObservation(h.read(), old)).toBeFalsy();
    expect(inventoryTargets(h.read())).toStrictEqual([]);
  },
);

test("keeps provisional creation private and refuses its retired completion", () => {
  const h = inventory();
  h.send({ type: "begin-creation", id: "created", now: 1 });
  const observation = h.observe("created", 1);
  expect(inventoryTargets(h.read())).toStrictEqual([page]);
  h.send({ type: "retired", id: "created" });
  h.send({
    type: "created",
    observation,
    target: { id: "created", title: "Stale" },
  });
  expect(inventoryTargets(h.read())).toStrictEqual([page]);
});

test("accepts creation metadata independently without reversing a newer negative membership", () => {
  const h = inventory();
  h.send({ type: "begin-creation", id: page.id, now: 1 });
  const creation = h.observe(page.id, 1);
  h.send({
    type: "membership",
    observation: h.observe(page.id, 2),
    member: false,
  });
  h.send({
    type: "created",
    observation: creation,
    target: { ...page, title: "Created" },
  });
  expect(h.read().entries.get(page.id)?.target?.title).toBe("Created");
  expect(inventoryTargets(h.read())).toStrictEqual([]);
});

test("anchors scope expiry to dispatch and never renews it from title events", () => {
  const h = inventory();
  const observation = h.observe(page.id, 9000);
  h.send({
    type: "metadata",
    target: { ...page, title: "At receipt" },
    now: 18_000,
  });
  h.send({ type: "membership", observation, member: true });
  expect(h.read().entries.get(page.id)?.expiresAt).toBe(29_000);
  h.send({
    type: "metadata",
    target: { ...page, title: "Later" },
    now: 28_000,
  });
  expect(h.read().entries.get(page.id)?.expiresAt).toBe(29_000);
  expect(inventoryExpiry(h.read())).toBe(20_000);
});

test("retires round journals with explicit operations and leaves prior state unchanged", () => {
  const h = inventory();
  const before = h.read();
  const round = h.send({ type: "begin-round", now: 1 }).round!;
  h.send({ type: "closed", id: page.id });
  for (let index = 0; index < 513; index++) {
    h.send({ type: "retired", id: "worker-" + index });
  }
  expect(currentRound(h.read(), round)).toBeFalsy();
  expect(before.entries.get(page.id)?.target).toStrictEqual(page);
  expect(inventoryTargets(h.read())).toStrictEqual([]);
});

test("retains removal evidence beyond 512 changes until the active round completes", () => {
  const h = inventory();
  const round = h.send({ type: "begin-round", now: 0 }).round!;
  for (let index = 0; index < 700; index++) {
    h.send({ type: "retired", id: "worker-" + index });
  }
  h.send({
    type: "listed",
    round,
    targets: [page, { id: "worker-699", title: "Retired" }],
  });
  expect(h.read().entries.has("worker-699")).toBeFalsy();
  h.send({ type: "complete-round", round });
  expect(h.read().round).toBeNull();
  expect(inventoryTargets(h.read())).toStrictEqual([page]);
});

test("coalesces repeated journal IDs and bounds retained removal text", () => {
  const h = inventory();
  h.send({ type: "begin-round", now: 0 });
  const longId = "x".repeat(1024 * 1024);
  for (let index = 0; index < 9; index++) {
    h.send({ type: "retired", id: longId });
  }
  expect(h.read().round?.changed.size).toBe(1);
  expect(() => {
    for (let index = 0; index < 9; index++) {
      h.send({ type: "retired", id: longId + index });
    }
  }).toThrow("Browser target changes exceed the discovery memory budget.");
  h.send({ type: "invalidate-round" });
  expect(h.read().round).toBeNull();
  expect(inventoryTargets(h.read())).toStrictEqual([page]);
});
