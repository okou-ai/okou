import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  ATTACHMENT_RUN_ID,
  artifactFile,
  mockAttachmentChat,
  findNamedLink,
} from "./chat-attachment-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function openArtifact() {
  const file = artifactFile("estuary.md", { contentType: "text/markdown" });
  context.mocks.http.get(file.url, () => {
    return new Response("# Estuary notes", {
      headers: { "Content-Type": "text/markdown" },
    });
  });
  mockAttachmentChat(context, {
    artifacts: [file],
    chatEvents: [
      {
        role: "assistant",
        content: "[Read the estuary notes](" + file.url + ")",
        createdAt: "2026-08-10T10:00:00Z",
        runId: ATTACHMENT_RUN_ID,
        runEventId: "estuary-report",
        sequenceNumber: 1,
      },
    ],
  });
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  const link = await findNamedLink("Read the estuary notes");
  click(link);
  const seam = await screen.findByRole("separator", { name: "Resize sidebar" });
  const parent = seam.parentElement;
  if (!parent) {
    throw new Error("Missing workspace pane");
  }
  vi.spyOn(parent, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1600, 900),
  );
  const capture = new Set<number>();
  Object.defineProperties(seam, {
    setPointerCapture: {
      configurable: true,
      value: (id: number) => {
        return capture.add(id);
      },
    },
    releasePointerCapture: {
      configurable: true,
      value: (id: number) => {
        return capture.delete(id);
      },
    },
    hasPointerCapture: {
      configurable: true,
      value: (id: number) => {
        return capture.has(id);
      },
    },
  });
  return { seam, link };
}
function touch(
  handle: HTMLElement,
  phase: "pointerdown" | "pointermove" | "pointerup",
  id: number,
  x: number,
  primary = true,
) {
  fireEvent(
    handle,
    new PointerEvent(phase, {
      bubbles: true,
      isPrimary: primary,
      pointerType: "touch",
      pointerId: id,
      clientX: x,
      button: 0,
      buttons: phase === "pointerup" ? 0 : 1,
    }),
  );
}
function mask() {
  return document.querySelector("[data-chat-thread-sidebar-resize-mask]");
}
function close() {
  return findFastControl("button", "Close artifact");
}
test("chat-thread-sidebar-resize-001 releasing the primary touch fixes the artifact width at 600 pixels", async () => {
  const { seam } = await openArtifact();
  touch(seam, "pointerdown", 11, 1150);
  expect(seam.hasPointerCapture(11)).toBeTruthy();
  expect(mask()).toBeInTheDocument();
  touch(seam, "pointermove", 11, 1000);
  await waitFor(() => {
    expect(seam).toHaveAttribute("aria-valuenow", "600");
  });
  touch(seam, "pointerup", 11, 1000);
  expect(mask()).toBeNull();
  expect(seam.hasPointerCapture(11)).toBeFalsy();
  touch(seam, "pointermove", 11, 860);
  expect(seam).toHaveAttribute("aria-valuenow", "600");
  click(await close());
  await waitFor(() => {
    expect(seam).not.toBeInTheDocument();
  });
});
test("chat-thread-sidebar-resize-004 a second contact cannot move or release the primary resize", async () => {
  const { seam } = await openArtifact();
  touch(seam, "pointerdown", 32, 900, false);
  expect(mask()).toBeNull();
  touch(seam, "pointerdown", 31, 1100);
  expect(mask()).toBeInTheDocument();
  const initial = seam.getAttribute("aria-valuenow");
  touch(seam, "pointermove", 32, 760, false);
  touch(seam, "pointerup", 32, 760, false);
  expect(seam.getAttribute("aria-valuenow")).toBe(initial);
  expect(mask()).toBeInTheDocument();
  expect(seam.hasPointerCapture(31)).toBeTruthy();
  touch(seam, "pointerup", 31, 1100);
  expect(mask()).toBeNull();
});
test("chat-thread-sidebar-resize-005 closing the artifact during a held touch releases capture before reopening", async () => {
  const { seam, link } = await openArtifact();
  touch(seam, "pointerdown", 41, 1160);
  expect(seam.hasPointerCapture(41)).toBeTruthy();
  expect(mask()).toBeInTheDocument();
  click(await close());
  await waitFor(() => {
    expect(seam).not.toBeInTheDocument();
    expect(mask()).toBeNull();
    expect(seam.hasPointerCapture(41)).toBeFalsy();
  });
  click(link);
  await screen.findByRole("separator", { name: "Resize sidebar" });
  expect(mask()).toBeNull();
});
