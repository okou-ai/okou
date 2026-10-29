import { sequences as eventSequences } from "./sequences.ts";
import { expect, test } from "vitest";
import { NativeComposition } from "../input/composition.ts";
import { InputLifecycle, type InputTransition } from "../input/lifecycle.ts";

const shift = { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" } as const;
const transitions = [
  ["blur", true, false],
  ["navigation-started", true, false],
  ["same-document", true, false],
  ["document-lost", false, false],
  ["target-replaced", true, true],
  ["paused", true, true],
  ["disconnected", false, true],
  ["disposed", true, true],
  ["failed", true, false],
] as const satisfies readonly (readonly [InputTransition, boolean, boolean])[];

test.each(transitions)(
  "%s cancels the old owner and applies its document/transport release policy",
  (reason, release, terminal) => {
    const lifecycle = new InputLifecycle("owned-session");
    const owner = lifecycle.owner;
    lifecycle.pressKey(owner, shift);
    lifecycle.pointer(owner, { x: 20, y: 40 }, "left");
    const cleanup = lifecycle.transition(reason)!;
    expect(lifecycle.owns(owner)).toBeFalsy();
    expect(lifecycle.available).toBe(!terminal);
    expect(cleanup.owner).toBe(owner);
    expect(cleanup.keys).toStrictEqual(release ? [shift] : []);
    expect(cleanup.buttons).toStrictEqual(release ? ["left"] : []);
    expect(cleanup.point).toStrictEqual({ x: 20, y: 40 });
    expect(lifecycle.transition(reason)?.keys ?? []).toStrictEqual([]);
    expect(lifecycle.transition(reason)?.buttons ?? []).toStrictEqual([]);
    expect(
      lifecycle.available || lifecycle.transition("blur") === null,
    ).toBeTruthy();
  },
);

test.each([
  "blur",
  "navigation-started",
  "same-document",
  "document-lost",
  "failed",
] as const)(
  "late release results cannot alter a new owner after %s",
  (reason) => {
    const lifecycle = new InputLifecycle("owned-session");
    const old = lifecycle.owner;
    lifecycle.pressKey(old, shift);
    const oldKey = lifecycle.pressedKey(old, shift);
    lifecycle.pointer(old, { x: 20, y: 30 }, "left");
    const oldButton = lifecycle.pressedButton(old, "left");
    lifecycle.transition(reason);
    const current = lifecycle.owner;
    lifecycle.pressKey(current, shift);
    lifecycle.pointer(current, { x: 80, y: 90 }, "left");
    lifecycle.releaseKey(old, shift, oldKey);
    lifecycle.releaseButton(old, "left", oldButton);
    const cleanup = lifecycle.transition("blur")!;
    expect(cleanup.keys).toStrictEqual([shift]);
    expect(cleanup.buttons).toStrictEqual(["left"]);
    expect(current.document).toBe(reason === "document-lost" ? 1 : 0);
  },
);

test("keeps tokens isolated even when two connections reuse the same session ID", () => {
  const first = new InputLifecycle("same-id");
  const second = new InputLifecycle("same-id");
  expect(first.owner).toStrictEqual(second.owner);
  expect(first.owns(second.owner)).toBeFalsy();
  first.pressKey(second.owner, shift);
  expect(first.transition("blur")!.keys).toStrictEqual([]);
});

test("keeps a later press owned when an earlier release is acknowledged", () => {
  const lifecycle = new InputLifecycle("owned-session");
  const owner = lifecycle.owner;
  const point = { x: 20, y: 30 };
  lifecycle.pressKey(owner, shift);
  lifecycle.pointer(owner, point, "left");
  const oldKey = lifecycle.pressedKey(owner, shift);
  const oldButton = lifecycle.pressedButton(owner, "left");
  // Reusing caller objects must still create distinct press generations.
  lifecycle.pressKey(owner, shift);
  lifecycle.pointer(owner, point, "left");
  lifecycle.releaseKey(owner, shift, oldKey);
  lifecycle.releaseButton(owner, "left", oldButton);
  expect(lifecycle.transition("blur")).toMatchObject({
    keys: [shift],
    buttons: ["left"],
  });
});

test("owns distinct keys when a native keyboard provides an empty code", () => {
  const lifecycle = new InputLifecycle("owned-session");
  const modifier = { ...shift, code: "" };
  const letter = { type: "keyDown", key: "a", code: "" } as const;
  lifecycle.pressKey(lifecycle.owner, modifier);
  lifecycle.pressKey(lifecycle.owner, letter);
  expect(lifecycle.transition("blur")!.keys).toStrictEqual([modifier, letter]);
});

test("preserves pressed-input accounting across bounded event sequences", () => {
  const actions = ["press", "acknowledge", "cancel"] as const;
  for (const sequence of eventSequences(actions, 4)) {
    const lifecycle = new InputLifecycle("owned-session");
    let held = false;
    const cancellations: { actual: number; expected: number }[] = [];
    for (const action of sequence) {
      if (action === "press") {
        lifecycle.pressKey(lifecycle.owner, shift);
        held = true;
      } else if (action === "acknowledge") {
        lifecycle.releaseKey(
          lifecycle.owner,
          shift,
          lifecycle.pressedKey(lifecycle.owner, shift),
        );
        held = false;
      } else {
        cancellations.push({
          actual: lifecycle.transition("blur")!.keys.length,
          expected: held ? 1 : 0,
        });
        held = false;
      }
    }
    for (const { actual, expected } of cancellations) {
      expect(actual).toBe(expected);
    }
    expect(lifecycle.transition("blur")!.keys).toHaveLength(held ? 1 : 0);
  }
});

test.each(["before", "after", "none"] as const)(
  "composition commits once with %s trailing-input ordering and preserves repeated text",
  (ordering) => {
    const owner = new InputLifecycle("owned-session").owner;
    const composition = new NativeComposition();
    composition.start(owner);
    expect(composition.input("preedit", owner, true, true).text).toBe("");
    const before =
      ordering === "before"
        ? composition.input("中", owner, true, true).text
        : "";
    expect(before).toBe("");
    expect(composition.end("中", owner).text).toBe("中");
    const after =
      ordering !== "none"
        ? composition.input("中", owner, true, false).text
        : "";
    expect(after).toBe("");
    expect(
      composition.input(
        ordering === "none" ? "中中" : "中",
        owner,
        false,
        false,
      ).text,
    ).toBe("中");
    expect(composition.end("中", owner).text).toBe("");
  },
);

test.each([
  "blur",
  "navigation-started",
  "same-document",
  "document-lost",
  "failed",
] as const)(
  "composition cannot commit to a replacement focus after %s",
  (reason) => {
    const lifecycle = new InputLifecycle("owned-session");
    const composition = new NativeComposition();
    composition.start(lifecycle.owner);
    lifecycle.transition(reason);
    const owner = lifecycle.owner;
    expect(composition.end("old text", owner).text).toBe("");
    expect(composition.input("old text", owner, true, false).text).toBe("");
    expect(composition.input("🙂", owner, false, false).text).toBe("🙂");
    composition.start(owner);
    expect(composition.end("current text", owner).text).toBe("current text");
  },
);

test("cancels native composition and rejects orphaned composition input", () => {
  const owner = new InputLifecycle("owned-session").owner;
  const composition = new NativeComposition();
  composition.start(owner);
  expect(composition.end("", owner).text).toBe("");
  composition.start(owner);
  composition.reset();
  expect(composition.input("late value", owner, true, true)).toStrictEqual({
    keep: false,
    text: "",
  });
  expect(composition.end("late value", null)).toStrictEqual({
    value: "",
    text: "",
  });
  expect(composition.input("ordinary", owner, false, false).text).toBe(
    "ordinary",
  );
});

test("deduplicates preedit updates and excludes already consumed local text and selection suffixes", () => {
  const owner = new InputLifecycle("owned-session").owner;
  const composition = new NativeComposition();
  composition.start(owner, "中", 1, 1);
  expect(composition.update("ni", owner)).toStrictEqual({
    text: "ni",
    selectionStart: 2,
    selectionEnd: 2,
  });
  expect(composition.input("中ni", owner, true, true).preedit).toBeNull();
  expect(composition.input("中nihao", owner, true, true).preedit?.text).toBe(
    "nihao",
  );
  expect(composition.update("", owner)?.text).toBe("");
  expect(composition.update("", owner)).toBeNull();
  expect(
    composition.update("stale", new InputLifecycle("other").owner),
  ).toBeNull();
  composition.start(owner, "leftOLDright", 4, 7);
  expect(
    composition.input("leftniright", owner, true, true, { start: 6, end: 6 })
      .preedit?.text,
  ).toBe("ni");
  expect(composition.end("你", owner).text).toBe("你");
  expect(composition.input("你", owner, true, false).text).toBe("");
});

test("mirrors selection changes within preedit without resending identical state", () => {
  const owner = new InputLifecycle("owned-session").owner;
  const composition = new NativeComposition();
  composition.start(owner, "prefixsuffix", 6, 6);
  expect(
    composition.input("prefixnihaosuffix", owner, true, true, {
      start: 7,
      end: 9,
    }).preedit,
  ).toStrictEqual({
    text: "nihao",
    selectionStart: 1,
    selectionEnd: 3,
  });
  expect(
    composition.input("prefixnihaosuffix", owner, false, false, {
      start: 7,
      end: 9,
    }).preedit,
  ).toBeNull();
  expect(
    composition.input("prefixnihaosuffix", owner, false, false, {
      start: 8,
      end: 8,
    }).preedit,
  ).toStrictEqual({
    text: "nihao",
    selectionStart: 2,
    selectionEnd: 2,
  });
});

test("retains composition cleanup until its matching acknowledgement and only in the original document", () => {
  const lifecycle = new InputLifecycle("owned-session");
  const owner = lifecycle.owner;
  const first = lifecycle.compose(owner);
  const second = lifecycle.compose(owner);
  lifecycle.finishComposition(owner, first);
  expect(lifecycle.composition(owner)).toBe(second);
  expect(lifecycle.transition("blur")!.composition).toBeTruthy();
  expect(lifecycle.retainsDocument(owner)).toBeTruthy();
  const current = lifecycle.owner;
  lifecycle.compose(current);
  lifecycle.finishComposition(owner, second);
  expect(lifecycle.transition("document-lost")!.composition).toBeFalsy();
  expect(lifecycle.retainsDocument(current)).toBeFalsy();
});
