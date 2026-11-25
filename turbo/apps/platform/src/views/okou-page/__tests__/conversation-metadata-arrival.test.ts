import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  installContinuityWorkspace,
  continuityThread,
} from "./chat-continuity-test-helpers.ts";
const context = testContext();
const left = Object.freeze(continuityThread(179, 1, "Quarterly review"));
const right = Object.freeze(continuityThread(179, 2, "Supplier notes"));
function pane(id: string) {
  return screen.queryAllByRole("region", { name: "Chat thread" }).find((el) => {
    return el.dataset.chatThreadContainerId === id;
  });
}
function usable(id: string) {
  return waitFor(() => {
    const element = pane(id);
    if (!element) {
      throw new Error("Missing conversation " + id);
    }
    const editor = element.querySelector('[contenteditable="true"]');
    expect(editor).toBeVisible();
    expect(editor).not.toHaveAttribute("aria-disabled", "true");
    return element;
  });
}
async function sideBySide(failPrimary = false) {
  const canonical = context.mocks.deferred<void>();
  const gates = new Map(
    [left, right].map((t) => {
      return [
        t.id,
        {
          request: context.mocks.deferred<AbortSignal>(),
          response: context.mocks.deferred<void>(),
        },
      ] as const;
    }),
  );
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 179,
    threads: [left, right],
    chatListRemoteGate: canonical.promise,
  });
  context.mocks.api(
    chatThreadMetadataContract.get,
    async ({ params, request, respond }) => {
      const gate = gates.get(params.id);
      if (!gate) {
        throw new Error("Unconfigured conversation");
      }
      if (!gate.request.settled()) {
        gate.request.resolve(request.signal);
      }
      await gate.response.promise;
      if (params.id === left.id && failPrimary && !canonical.settled()) {
        return respond(503, {
          error: {
            code: "UNAVAILABLE",
            message: "Quarterly metadata unavailable",
          },
        });
      }
      const row = params.id === left.id ? left : right;
      return respond(200, {
        id: row.id,
        title: row.title,
        selectedModel: row.selectedModel,
        modelSettings: {},
        serviceTier: null,
        pinnedAt: null,
        archived: false,
        muted: false,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
      });
    },
  );
  const page = await startPage({
    context,
    sharedWorkerTestTransport: "message-port",
    auth: pageOptions.auth,
    cachedChatThreadEvents: { snapshot: null, events: [] },
    path: "/chats/" + left.id + "?sidebar=" + right.id,
  });
  return {
    page,
    canonical,
    left: gates.get(left.id)!,
    right: gates.get(right.id)!,
  };
}
test("chat-metadata-009 The primary and side composers become usable when their own metadata arrives", async () => {
  const world = await sideBySide();
  try {
    const [, rightSignal] = await Promise.all([
      world.left.request.promise,
      world.right.request.promise,
    ]);
    world.left.response.resolve();
    await world.page.content;
    await usable(left.id);
    expect(pane(right.id)).toBeUndefined();
    expect(rightSignal.aborted).toBeFalsy();
    world.right.response.resolve();
    await usable(right.id);
    expect(pane(left.id)).toBeVisible();
    await waitFor(() => {
      expect(document.title).toContain("Quarterly review");
    });
    world.canonical.resolve();
    await world.page.ready;
  } finally {
    if (!world.canonical.settled()) {
      world.canonical.resolve();
    }
    for (const gate of [world.left, world.right]) {
      if (!gate.response.settled()) {
        gate.response.resolve();
      }
    }
  }
});

test("chat-metadata-008 the side composer opens Connectors before canonical recovery of the failed primary", async () => {
  const session = await sideBySide(true);
  try {
    await Promise.all([
      session.left.request.promise,
      session.right.request.promise,
    ]);
    session.left.response.resolve();
    session.right.response.resolve();
    const side = await usable(right.id);
    const trigger = await within(side).findByLabelText("Connectors", {
      selector: "button",
    });
    await userEvent.click(trigger);
    const connectors = await screen.findByRole("dialog", {
      name: "Connectors",
    });
    await expect(
      findFastControl("button", "Add connectors", connectors),
    ).resolves.toBeEnabled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(connectors).not.toBeInTheDocument();
    });
    expect(pane(left.id)).toBeUndefined();
    expect(screen.getAllByRole("region", { name: "Chat thread" })).toHaveLength(
      1,
    );
    session.canonical.resolve();
    await usable(left.id);
    await expect(usable(right.id)).resolves.toBeVisible();
  } finally {
    if (!session.canonical.settled()) {
      session.canonical.resolve();
    }
  }
});
