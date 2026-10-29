import { expect, test } from "vitest";
import {
  activeDisplayIntent,
  canBeginDisplay,
  createDisplayPolicy,
  decideDisplay,
  transitionDisplay,
  type DisplayEvent,
  type DisplayIntent,
  type DisplayPolicy,
  type DisplayStage,
} from "../display/policy.ts";

import type { WindowSizeSync } from "../viewer/types.ts";

const local = Object.freeze({ width: 640, height: 480, dpr: 2 });
const latest = Object.freeze({ width: 900, height: 700, dpr: 1.5 });
const completed = (proof: "reused" | "painted") => {
  return {
    kind: "completed",
    proof,
    windowId: 0,
    dpr: 2,
  } as const;
};

function apply(policy: DisplayPolicy, ...events: DisplayEvent[]) {
  return events.reduce(transitionDisplay, policy);
}

function ready(mode: WindowSizeSync = "initial") {
  return apply(
    createDisplayPolicy(),
    { type: "select", owner: {} },
    { type: "measure", size: local },
    { type: "mode", mode },
    ...(mode === "off" ? [{ type: "manual" } as const] : []),
  );
}

function begin(policy: DisplayPolicy) {
  const next = transitionDisplay(policy, { type: "begin" });
  const intent = activeDisplayIntent(next);
  if (!intent) {
    throw new Error("The fixture has no admitted request.");
  }
  return { policy: next, intent };
}

function advance(
  policy: DisplayPolicy,
  intent: DisplayIntent,
  stage: DisplayStage,
) {
  const events: DisplayEvent[] = [];
  if (stage !== "preparing") {
    events.push({ type: "prepared", intent });
  }
  if (["writing", "presenting", "recovering"].includes(stage)) {
    events.push({ type: "stage", intent, stage: "writing" });
  }
  if (stage === "presenting") {
    events.push({ type: "stage", intent, stage: "presenting" });
  }
  if (stage === "recovering") {
    events.push({ type: "stage", intent, stage: "recovering" });
  }
  return apply(policy, ...events);
}

test.each(["reused", "painted"] as const)(
  "commits %s initial success through the same window-history contract",
  (proof) => {
    const started = begin(ready());
    const before = started.policy;
    const prepared = advance(
      before,
      started.intent,
      proof === "reused" ? "prepared" : "presenting",
    );
    expect(prepared.initial.size).toBe(0);
    const done = transitionDisplay(prepared, {
      type: "finished",
      intent: started.intent,
      outcome: completed(proof),
    });
    expect(done.initial.get(0)).toBe(2);
    expect(before.initial.size).toBe(0);
    expect(activeDisplayIntent(done)).toBeNull();
    const next = begin(
      apply(
        done,
        { type: "measure", size: latest },
        { type: "select", owner: {} },
      ),
    );
    expect(decideDisplay(next.policy, next.intent, 0)).toStrictEqual({
      kind: "restore-density",
      dpr: 2,
    });
    expect(decideDisplay(next.policy, next.intent, 9)).toStrictEqual({
      kind: "fit",
      size: latest,
    });
  },
);

test.each(["writing", "presenting", "recovering"] as const)(
  "cannot turn dispatched %s work into a deferred retry",
  (stage) => {
    const started = begin(ready());
    const policy = advance(started.policy, started.intent, stage);
    const result = transitionDisplay(policy, {
      type: "finished",
      intent: started.intent,
      outcome: { kind: "deferred" },
    });
    expect(result).toBe(policy);
    expect(canBeginDisplay(result)).toBeFalsy();
    expect(result.initial.size).toBe(0);
  },
);

test.each(["preparing", "prepared", "writing", "recovering"] as const)(
  "cannot commit a painted success during %s",
  (stage) => {
    const started = begin(ready());
    const policy = advance(started.policy, started.intent, stage);
    const rejected = transitionDisplay(policy, {
      type: "finished",
      intent: started.intent,
      outcome: completed("painted"),
    });
    expect(rejected.initial.size).toBe(0);
    expect(rejected.selection?.completed).toBeFalsy();
    expect(canBeginDisplay(rejected)).toBeFalsy();
    expect(activeDisplayIntent(rejected)).toBe(started.intent);
  },
);

test.each(["reused", "painted"] as const)(
  "preserves measurements arriving after preparation before %s completion",
  (proof) => {
    const started = begin(ready("live"));
    let policy = transitionDisplay(started.policy, {
      type: "measure",
      size: { ...local, width: 700 },
    });
    expect(decideDisplay(policy, started.intent, 0)).toStrictEqual({
      kind: "fit",
      size: { ...local, width: 700 },
    });
    policy = advance(
      policy,
      started.intent,
      proof === "reused" ? "prepared" : "presenting",
    );
    policy = apply(
      policy,
      { type: "measure", size: latest },
      { type: "finished", intent: started.intent, outcome: completed(proof) },
    );
    expect(canBeginDisplay(policy)).toBeTruthy();
    const next = begin(policy);
    expect(decideDisplay(next.policy, next.intent, 0)).toStrictEqual({
      kind: "fit",
      size: latest,
    });
    expect(next.intent).not.toBe(started.intent);
  },
);

const stages = Object.freeze([
  "preparing",
  "prepared",
  "writing",
  "presenting",
  "recovering",
] as const);
test.each(stages)(
  "retains a newer manual request through mode/hidden changes while %s",
  (stage) => {
    const started = begin(ready("off"));
    let policy = advance(started.policy, started.intent, stage);
    policy = apply(
      policy,
      { type: "manual" },
      { type: "mode", mode: "live" },
      { type: "measure", size: latest },
      { type: "measure", size: null },
      { type: "mode", mode: "off" },
      {
        type: "finished",
        intent: started.intent,
        outcome: {
          kind:
            stage === "preparing" || stage === "prepared"
              ? "deferred"
              : "failed",
        },
      },
    );
    expect(canBeginDisplay(policy)).toBeFalsy();
    expect(policy.pending?.source).toBe("manual");
    expect(policy.initial.size).toBe(0);
    policy = transitionDisplay(policy, { type: "measure", size: latest });
    const next = begin(policy);
    expect(next.intent.source).toBe("manual");
    expect(decideDisplay(next.policy, next.intent, 0)).toStrictEqual({
      kind: "fit",
      size: latest,
    });
  },
);

test.each(stages)(
  "rejects old-owner outcomes and progress while %s",
  (stage) => {
    const started = begin(ready());
    const owner = {};
    const replaced = apply(
      advance(started.policy, started.intent, stage),
      { type: "select", owner },
      { type: "stage", intent: started.intent, stage: "recovering" },
      {
        type: "finished",
        intent: started.intent,
        outcome: completed("painted"),
      },
    );
    expect(replaced.initial.size).toBe(0);
    expect(replaced.selection).toStrictEqual({
      owner,
      completed: false,
    });
    const next = begin(replaced);
    expect(next.intent.owner).toBe(owner);
    expect(
      transitionDisplay(next.policy, {
        type: "finished",
        intent: started.intent,
        outcome: { kind: "failed" },
      }),
    ).toBe(next.policy);
  },
);

test.each(["mode", "manual", "select"] as const)(
  "keeps failures latched until an explicit %s retry",
  (retry) => {
    const started = begin(ready());
    let policy = apply(
      started.policy,
      { type: "finished", intent: started.intent, outcome: { kind: "failed" } },
      { type: "measure", size: latest },
      { type: "mode", mode: "initial" },
    );
    expect(canBeginDisplay(policy)).toBeFalsy();
    expect(policy.initial.size).toBe(0);
    if (retry === "mode") {
      policy = transitionDisplay(policy, { type: "mode", mode: "live" });
    } else if (retry === "manual") {
      policy = transitionDisplay(policy, { type: "manual" });
    } else {
      policy = transitionDisplay(policy, { type: "select", owner: {} });
    }
    expect(canBeginDisplay(policy)).toBeTruthy();
  },
);

test.each(["initial", "live"] as const)(
  "resumes interrupted %s work once after image recovery without a new measurement",
  (mode) => {
    const started = begin(ready(mode));
    const failed = apply(
      advance(started.policy, started.intent, "presenting"),
      { type: "suspend", value: true },
      { type: "finished", intent: started.intent, outcome: { kind: "failed" } },
    );
    expect(canBeginDisplay(failed)).toBeFalsy();
    const next = begin(
      transitionDisplay(failed, { type: "suspend", value: false }),
    );
    expect(decideDisplay(next.policy, next.intent, 0)).toStrictEqual({
      kind: "fit",
      size: local,
    });
    const rejected = apply(
      next.policy,
      { type: "finished", intent: next.intent, outcome: { kind: "failed" } },
      { type: "suspend", value: false },
    );
    expect(canBeginDisplay(rejected)).toBeFalsy();
  },
);

test.each(["initial", "live"] as const)(
  "does not replay completed %s work when an image recovers",
  (mode) => {
    const started = begin(ready(mode));
    const recovered = apply(
      advance(started.policy, started.intent, "presenting"),
      {
        type: "finished",
        intent: started.intent,
        outcome: completed("painted"),
      },
      { type: "suspend", value: true },
      { type: "suspend", value: false },
    );
    expect(recovered.selection?.completed).toBeTruthy();
    expect(canBeginDisplay(recovered)).toBeFalsy();
    expect(recovered.initial.size).toBe(mode === "initial" ? 1 : 0);
  },
);

function permutations<T>(values: readonly T[]): T[][] {
  if (!values.length) {
    return [[]];
  }
  return values.flatMap((value, index) => {
    return permutations(
      values.filter((_, i) => {
        return i !== index;
      }),
    ).map((rest) => {
      return [value, ...rest];
    });
  });
}

test.each(
  permutations(["off", "hidden", "replace", "complete"] as const).map(
    (order) => {
      return [order.join(" → "), order] as const;
    },
  ),
)("commits only a still-owned dispatched result: %s", (_name, order) => {
  const started = begin(ready());
  let policy = advance(started.policy, started.intent, "presenting");
  const owner = {};
  for (const event of order) {
    if (event === "off") {
      policy = transitionDisplay(policy, { type: "mode", mode: "off" });
    }
    if (event === "hidden") {
      policy = transitionDisplay(policy, { type: "measure", size: null });
    }
    if (event === "replace") {
      policy = transitionDisplay(policy, { type: "select", owner });
    }
    if (event === "complete") {
      policy = transitionDisplay(policy, {
        type: "finished",
        intent: started.intent,
        outcome: completed("painted"),
      });
    }
  }
  expect(policy.initial.get(0)).toBe(
    order.indexOf("complete") < order.indexOf("replace") ? 2 : undefined,
  );
  expect(policy.selection?.owner).toBe(owner);
  expect(policy.pending).toBeNull();
  expect(canBeginDisplay(policy)).toBeFalsy();
});

test("updates remembered density for manual success and retires all policy on close", () => {
  const first = begin(ready());
  let policy = transitionDisplay(
    advance(first.policy, first.intent, "presenting"),
    { type: "finished", intent: first.intent, outcome: completed("painted") },
  );
  policy = apply(
    policy,
    { type: "mode", mode: "off" },
    { type: "measure", size: latest },
    { type: "manual" },
  );
  const second = begin(policy);
  policy = transitionDisplay(
    advance(second.policy, second.intent, "prepared"),
    {
      type: "finished",
      intent: second.intent,
      outcome: { ...completed("reused"), dpr: 1.5 },
    },
  );
  expect(policy.initial.get(0)).toBe(1.5);
  const closed = transitionDisplay(policy, { type: "close" });
  expect(closed.initial.size).toBe(0);
  expect(closed.selection).toBeNull();
  expect(
    apply(
      closed,
      { type: "select", owner: {} },
      { type: "mode", mode: "live" },
      { type: "measure", size: local },
      { type: "manual" },
    ),
  ).toBe(closed);
});
