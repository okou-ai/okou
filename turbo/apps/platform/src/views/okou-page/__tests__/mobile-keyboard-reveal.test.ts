import { waitForAnimationFrame } from "../../../signals/utils.ts";
import { waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
async function focusedComposer(standalone: boolean) {
  const visual = Object.assign(new EventTarget(), {
    height: 844,
    width: 390,
    scale: 1,
    offsetTop: 0,
  });
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("visualViewport", visual);
  context.mocks.browser.matchMedia((q) => {
    return (
      q === "(pointer: coarse)" ||
      (standalone && q === "(display-mode: standalone)")
    );
  });
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  await setupPage({ context, path: RUN_PATH });
  const editor = await findComposerEditor();
  editor.focus();
  const card = editor.closest<HTMLElement>("[data-slot='chat-composer-card']");
  if (!card) {
    throw new Error("Composer card is missing");
  }
  const reveal = vi.spyOn(card, "scrollIntoView");
  return { editor, visual, reveal };
}

test("visual-viewport-keyboard-001 Five keyboard sessions reveal the focused standalone composer once apiece", async () => {
  const { editor, visual, reveal } = await focusedComposer(true);
  const layout = document.documentElement;
  for (const [index, height] of [740, 843.4, 740, 843.4, 740].entries()) {
    editor.focus();
    visual.height = 520;
    visual.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      return expect(reveal).toHaveBeenCalledTimes(index + 1);
    });
    expect(reveal).toHaveBeenLastCalledWith({
      block: "end",
      behavior: "auto",
      inline: "nearest",
    });
    expect(
      layout.style.getPropertyValue("--okou-keyboard-scroll-reserve"),
    ).toBe("340px");
    visual.offsetTop = 100;
    visual.dispatchEvent(new Event("scroll"));
    await waitForAnimationFrame(context.signal);
    expect(reveal).toHaveBeenCalledTimes(index + 1);
    visual.height = height;
    visual.offsetTop = 0;
    visual.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      return expect(layout).not.toHaveAttribute("data-keyboard-open");
    });
    expect(
      layout.style.getPropertyValue("--okou-keyboard-scroll-reserve"),
    ).toBe("");
    expect(editor).toHaveFocus();
  }
});

test("visual-viewport-keyboard-002 An ordinary mobile tab reserves keyboard space without moving the composer", async () => {
  const { visual, reveal } = await focusedComposer(false);
  visual.height = 520;
  visual.offsetTop = 100;
  visual.dispatchEvent(new Event("resize"));
  await waitFor(() => {
    return expect(document.documentElement).toHaveAttribute(
      "data-keyboard-open",
      "true",
    );
  });
  await waitForAnimationFrame(context.signal);
  expect(reveal).not.toHaveBeenCalled();
});
