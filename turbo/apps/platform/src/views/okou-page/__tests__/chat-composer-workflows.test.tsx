import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  chatThreadDraftContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  promptEvent,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { workflowOptions, slashChoice } from "./workflow-composer-boundary.ts";

const context = testContext();

function deck(title: string, id: string) {
  return {
    type: "template" as const,
    titleSnapshot: title,
    template: { type: "presentation" as const, selection: { templateId: id } },
  };
}

function restore(parts: ReturnType<typeof deck>[]) {
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts },
      draftAttachments: null,
    });
  });
}

test.each([
  ["chat-composer-workflows-001", false],
  ["chat-composer-workflows-006", true],
] as const)(
  "%s sends the selected presentation references and clears the composer",
  async (_id, active) => {
    const items = active
      ? [deck("Inventory charts", "inventory")]
      : [
          deck("Field report", "field-report"),
          deck("Revenue outlook", "revenue"),
        ];
    const sent = context.mocks.deferred<UserMessageDocument | undefined>();
    createChatRunFixtures(context).installRunChat({
      chatEvents: active
        ? [
            promptEvent({
              id: crypto.randomUUID(),
              runId: crypto.randomUUID(),
              seqId: 1,
              text: "Collect receipts",
            }),
          ]
        : [],
      onSendRequest: (b) => {
        return sent.resolve(b.userMessage);
      },
      onQueuedEventAppend: (b) => {
        return sent.resolve(b.userMessage);
      },
    });
    restore(items);
    await setupPage({ context, path: RUN_PATH });
    if (active) {
      await screen.findByText("Collect receipts", {
        selector: '[data-role="user"] *',
      });
    }
    const editor = await screen.findByLabelText("Message");
    await waitFor(() => {
      return expect(editor).toHaveTextContent(items[0].titleSnapshot);
    });
    click(await findAction("button", "Send"));
    const submitted = await sent.promise;
    expect(
      submitted?.parts.filter((p) => {
        return p.type === "template";
      }),
    ).toStrictEqual(items);
    await waitFor(() => {
      return expect(editor.textContent?.trim()).toBe("");
    });
    const reference = await screen.findByText(items[0].titleSnapshot, {
      exact: true,
    });
    expect(reference).toBeVisible();
    const message = reference.closest('[data-role="user"]');
    const chips = Array.from(
      message!.querySelectorAll("[data-structured-template-reference]"),
    );
    expect(
      chips.map((chip) => {
        return chip.textContent;
      }),
    ).toStrictEqual(
      items.map((item) => {
        return item.titleSnapshot;
      }),
    );
    for (const [index, chip] of chips.entries()) {
      expect(chip).toBeVisible();
      expect(chip).toHaveAccessibleDescription(
        "Presentation · " + items[index].titleSnapshot,
      );
    }
  },
);

test("chat-composer-workflows-010 a URL after a workflow remains literal and creates no second highlight", async () => {
  createChatRunFixtures(context).installRunChat();
  workflowOptions(context, ["pr-review"]);
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByLabelText("Message");
  await fill(editor, "/pr-review");
  await slashChoice("pr-review");
  await userEvent.keyboard(" ");
  const url = "https://www.okou.ai/en/use-cases/pr-review";
  await userEvent.setup({ delay: null }).paste(url);
  await waitFor(() => {
    return expect(editor).toHaveTextContent(url);
  });
  expect(
    [...editor.querySelectorAll(".text-brand-text")].map((n) => {
      return n.textContent;
    }),
  ).toStrictEqual(["/pr-review"]);
  expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
});

test("chat-composer-workflows-003 a reopened pending lookup resolves and its workflow remains selectable on a later search", async () => {
  createChatRunFixtures(context).installRunChat();
  const first = context.mocks.deferred<void>(),
    started = context.mocks.deferred<void>();
  const entry = {
    id: crypto.randomUUID(),
    name: "pr-review",
    description: null,
    displayName: null,
  };
  let available = true;
  context.mocks.api(
    workflowsCollectionContract.composer,
    async ({ respond }) => {
      const result = available ? [entry] : [];
      if (!started.settled()) {
        started.resolve();
      }
      await first.promise;
      return respond(200, result);
    },
  );
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByLabelText("Message");
  await fill(editor, "/pr");
  await started.promise;
  await fill(editor, "");
  await fill(editor, "/pr");
  first.resolve();
  await slashChoice("pr-review");
  await fill(editor, "");
  available = false;
  await fill(editor, "/pr");
  click(await slashChoice("pr-review"));
  await waitFor(() => {
    return expect(editor.querySelector(".text-brand-text")).toHaveTextContent(
      "/pr-review",
    );
  });
});

test("chat-composer-workflows-007 selecting GitHub PR summarizer sends the same workflow reference shown inline", async () => {
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest: (b) => {
      return sent.resolve(b.userMessage);
    },
  });
  await setupPage({ context, path: "/" });
  await screen.findByLabelText("Message");
  click(await findAction("button", "Advanced workflows"));
  click(await findAction("button", "View all"));
  const dialog = await screen.findByRole("dialog");
  const input = dialog.querySelector("input");
  if (!input) {
    throw new Error("Missing template search");
  }
  await fill(input, "GitHub PR summarizer");
  click(
    await findAction(
      "button",
      "Select workflow template GitHub PR summarizer",
      dialog,
    ),
  );
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent("GitHub PR summarizer");
  });
  click(await findAction("button", "Send"));
  expect((await sent.promise)?.parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      titleSnapshot: "GitHub PR summarizer",
      template: {
        type: "workflow",
        selection: {
          workflowTemplateId: "workflow-template:github-pr-summarizer",
        },
      },
    }),
  );
  const title = await screen.findByText("GitHub PR summarizer", {
    selector: '[data-role="user"] [data-structured-template-reference] *',
  });
  expect(title).toBeVisible();
  expect(
    title.closest("[data-structured-template-reference]"),
  ).toHaveAccessibleDescription("Workflow · GitHub PR summarizer");
});

test("chat-composer-workflows-009 an unfinished file upload holds the selected presentation draft", async () => {
  const gate = context.mocks.deferred<void>();
  const item = deck("Launch plan slides", "launch-plan");
  createChatRunFixtures(context).installRunChat();
  restore([item]);
  const file = {
    id: crypto.randomUUID(),
    filename: "brief.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://files.example.org/brief.txt",
  };
  context.mocks.upload.success(file);
  context.mocks.api(uploadsContract.prepare, async ({ respond }) => {
    await gate.promise;
    return respond(200, {
      ...file,
      uploadUrl: "https://mock-upload.r2.test/" + file.id,
      uploadHeaders: {},
    });
  });
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent(item.titleSnapshot);
  });
  await expect(findAction("button", "Send")).resolves.toBeEnabled();
  await userEvent
    .setup({ delay: null })
    .upload(
      await screen.findByLabelText("Attach", { selector: "input" }),
      new File(["brief"], "brief.txt", { type: "text/plain" }),
    );
  try {
    await screen.findByRole("progressbar");
    const held = await findAction("button", "Send");
    expect(held).toBeDisabled();
    await userEvent.click(held);
    gate.resolve();
    await findAction("button", "Remove brief.txt");
    await expect(findAction("button", "Send")).resolves.toBeEnabled();
    expect(editor).toHaveTextContent(item.titleSnapshot);
    expect(document.querySelector('[data-role="user"]')).toBeNull();
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});
