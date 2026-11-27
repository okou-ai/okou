import {
  workflowAutomationsContract,
  type ChatThreadWorkflowAutomation,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  queryButton,
  RUN_THREAD_ID,
  RUN_PATH,
  findEnabledButton,
  completedEvent,
  promptEvent,
} from "./chat-run-test-fixtures.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  chatThreadDraftContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import userEvent from "@testing-library/user-event";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { workflowOptions, slashChoice } from "./workflow-composer-boundary.ts";

const context = testContext();

const last = "2026-09-12T13:05:00Z",
  next = "2026-09-12T15:05:00Z";

function releaseSchedule(): Extract<
  ChatThreadWorkflowAutomation,
  { kind: "schedule" }
> {
  return {
    id: crypto.randomUUID(),
    ownerUserId: "test-user-123",
    enabled: true,
    chatThreadId: RUN_THREAD_ID,
    lastRunAt: last,
    nextRunAt: next,
    official: null,
    workflow: {
      id: crypto.randomUUID(),

      name: "release-schedule",
      displayName: "Active release schedule",
      description: null,
    },
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 7200 },
    scheduleSummary: "Every 2 hours",
  };
}

test("chat-capability-automations-001 the active release schedule identifies both run times and its available actions", async () => {
  const record = releaseSchedule();
  createChatRunFixtures(context).installRunChat();
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(200, params.threadId === RUN_THREAD_ID ? [record] : []);
    },
  );
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  click(await findButton("More actions"));
  click(
    await waitFor(() => {
      const item = queryAllByRoleFast("menuitemradio").find((el) => {
        return el.textContent?.trim() === "Automations";
      });
      expect(item).toBeDefined();
      return item!;
    }),
  );
  const sidebar = await screen.findByTestId("automation-sidebar");
  const panel = within(sidebar);
  await panel.findByText("Active release schedule");
  const schedule = panel.getByRole("article");
  const card = within(schedule);
  function value(label: string) {
    return card.getByText(label, { selector: "dt" }).nextElementSibling;
  }
  expect(value("Status")).toHaveTextContent("Active");
  expect(value("Schedule")).toHaveTextContent("Every 2 hours");
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  expect(value("Last run")).toHaveTextContent(format.format(new Date(last)));
  expect(value("Next run")).toHaveTextContent(format.format(new Date(next)));
  expect(queryButton("Edit", schedule)).toBeEnabled();
  expect(queryButton("Run now", schedule)).toBeEnabled();
  expect(
    queryAllByRoleFast("link", sidebar).find((link) => {
      return link.textContent?.trim() === "View";
    }),
  ).toHaveAttribute(
    "href",
    "/workflows/" + record.workflow.id + "/automations",
  );
});

async function openAutomations() {
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  click(await findButton("More actions"));
  const menu = await screen.findByRole("menu");
  click(
    queryAllByRoleFast("menuitemradio", menu).find((el) => {
      return el.textContent?.trim() === "Automations";
    })!,
  );
  return screen.findByTestId("automation-sidebar");
}

test("chat-capability-automations-004 a thread change brings its release webhook into the open panel", async () => {
  const schedule = releaseSchedule(),
    records: ChatThreadWorkflowAutomation[] = [schedule];
  createChatRunFixtures(context).installRunChat();
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(200, params.threadId === RUN_THREAD_ID ? records : []);
    },
  );
  const panel = await openAutomations();
  const cards = within(panel);
  await cards.findByText("Active release schedule");
  expect(cards.queryByText("Release webhook")).toBeNull();
  records.push({
    ...schedule,
    id: crypto.randomUUID(),
    workflow: {
      ...schedule.workflow,
      id: crypto.randomUUID(),
      name: "release-hook",
      displayName: "Release webhook",
    },
    kind: "event",
    eventType: "webhook-received",
    eventConfig: {
      provider: "webhook",
      event: "received",
      auth: { mode: "hmac-sha256" },
    },
    schedule: null,
    scheduleSummary: null,
    lastReceivedAt: null,
    secretLastFour: "1234",
  });
  context.mocks.ably.trigger("chatThreadAutomationsChanged:" + RUN_THREAD_ID, {
    threadId: RUN_THREAD_ID,
  });
  await expect(cards.findByText("Release webhook")).resolves.toBeVisible();
  expect(cards.getByText("Active release schedule")).toBeVisible();
});

test("chat-capability-automations-005 finishing the five-hour save preserves a newer thirty-minute edit", async () => {
  const initial = releaseSchedule(),
    paused = {
      ...releaseSchedule(),
      enabled: false,
      workflow: {
        ...initial.workflow,
        id: crypto.randomUUID(),
        name: "paused-digest",
        displayName: "Paused digest schedule",
      },
    };
  initial.schedule = { type: "loop", intervalSeconds: 18_000 };
  initial.scheduleSummary = "Every 5 hours";
  const rescheduled = "2026-09-13T02:00:00Z";
  let saved = initial;
  const gate = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat();
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(
        200,
        params.threadId === RUN_THREAD_ID ? [saved, paused] : [],
      );
    },
  );
  context.mocks.api(
    workflowAutomationsContract.update,
    async ({ params, body, respond }) => {
      await gate.promise;
      if (
        params.id !== initial.id ||
        !("schedule" in body) ||
        body.schedule?.type !== "loop" ||
        body.schedule.intervalSeconds !== 18_000
      ) {
        return respond(400, {
          error: {
            code: "BAD_REQUEST",
            message: "Expected the edited release schedule",
          },
        });
      }
      saved = { ...initial, schedule: body.schedule, nextRunAt: rescheduled };
      return respond(200, saved);
    },
  );
  const panel = await openAutomations();
  const cards = within(panel);
  await cards.findByText("Paused digest schedule");
  const active = cards.getByText("Active release schedule").parentElement!
    .nextElementSibling as HTMLElement;
  async function edit(interval: string) {
    click(queryButton("Edit", active)!);
    const editor = await screen.findByRole("dialog", {
      name: "Edit automation",
    });
    const field = within(editor).getByRole("combobox", { name: "Every" });
    click(field);
    click(await screen.findByRole("option", { name: interval }));
    expect(field).toHaveTextContent(interval);
    return editor;
  }
  const first = await edit("5 hours");
  const save = queryButton("Save automation", first)!;
  click(save);
  await waitFor(() => {
    return expect(save).toBeDisabled();
  });
  click(queryButton("Close", first)!);
  await waitFor(() => {
    return expect(first).not.toBeInTheDocument();
  });
  const second = await edit("30 minutes");
  const updatedTime = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(rescheduled));
  expect(within(active).queryByText(updatedTime)).toBeNull();
  gate.resolve();
  await within(active).findByText(updatedTime);
  expect(within(active).getByText("Every 5 hours")).toBeVisible();
  expect(second).toBeVisible();
  expect(
    within(second).getByRole("combobox", { name: "Every" }),
  ).toHaveTextContent("30 minutes");
});

const workflowId = "a4c00000-0000-4000-8000-000000000018";

test("chat-capability-workflows-001 editing the audit schedule replaces the five-minute rule and closes its editor", async () => {
  createChatRunFixtures(context).installRunChat();
  let automation: Extract<ChatThreadWorkflowAutomation, { kind: "schedule" }> =
    {
      id: crypto.randomUUID(),
      ownerUserId: "test-user-123",
      enabled: true,
      chatThreadId: RUN_THREAD_ID,
      nextRunAt: null,
      lastRunAt: null,
      official: null,
      workflow: {
        id: workflowId,

        name: "audit-receipts",
        description: null,
        displayName: "Receipt audit",
      },
      kind: "schedule",
      schedule: { type: "loop", intervalSeconds: 300 },
      scheduleSummary: "Every 5 minutes",
    };
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(
        200,
        params.threadId === RUN_THREAD_ID ? [automation] : [],
      );
    },
  );
  context.mocks.api(
    workflowAutomationsContract.update,
    ({ body, params, respond }) => {
      if (
        params.id !== automation.id ||
        !("schedule" in body) ||
        body.schedule.type !== "loop"
      ) {
        throw new Error("Expected an interval change to the receipt audit");
      }
      automation = {
        ...automation,
        schedule: body.schedule,
        scheduleSummary:
          "Every " + body.schedule.intervalSeconds / 60 + " minutes",
      };
      return respond(200, automation);
    },
  );
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  click(await findButton("More actions"));
  click(
    await waitFor(() => {
      const item = queryAllByRoleFast("menuitemradio").find((el) => {
        return el.textContent?.trim() === "Automations";
      });
      expect(item).toBeDefined();
      return item!;
    }),
  );
  const sidebar = await screen.findByTestId("automation-sidebar");
  const panel = within(sidebar);
  await panel.findByText("Every 5 minutes");
  click(await findEnabledButton("Edit", sidebar));
  const dialog = await screen.findByRole("dialog");
  const editor = within(dialog);
  click(editor.getByRole("combobox", { name: "Every" }));
  click(await screen.findByRole("option", { name: "15 minutes" }));
  click(await findEnabledButton("Save automation", dialog));
  await panel.findByText("Every 15 minutes");
  expect(panel.queryByText("Every 5 minutes")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("chat-capability-workflows-003 completed, legacy and pending triggers render their corresponding workflow content", async () => {
  const main = crypto.randomUUID(),
    legacy = crypto.randomUUID();
  const prompt = "Review the unposted September invoices";
  const ignored = "Summarize outstanding receipts";
  const old = "Gather the legacy receipt bundle";
  const waiting = "Collect pending hotel expenses";
  function trigger(
    seqId: number,
    runId: string | undefined,
    name: string,
    brief: string,
    withPrompt = false,
  ): MockChatEventInput {
    return {
      id: crypto.randomUUID(),
      seqId,
      runId,
      createdAt: "2026-08-01T10:00:0" + seqId + ".000Z",
      role: "user",
      content: null,
      eventType: "input.automation",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: name,
            automationBrief: brief,
            ...(withPrompt ? { workflowId } : {}),
          },
          ...(withPrompt ? [{ type: "text" as const, text: prompt }] : []),
        ],
      },
    };
  }
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      trigger(1, main, "receipt-audit", ignored, true),
      completedEvent({ id: "audit-done", runId: main, seqId: 2 }),
      trigger(3, legacy, "legacy-audit", old),
      completedEvent({ id: "legacy-done", runId: legacy, seqId: 4 }),
      trigger(5, undefined, "pending-audit", waiting),
    ],
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  const text = await screen.findByText(prompt);
  const message = text.closest<HTMLElement>('[data-role="user"]')!;
  const turn = within(message);
  expect(
    queryAllByRoleFast("link", message).find((link) => {
      return link.getAttribute("aria-label") === "Open workflow receipt-audit";
    }),
  ).toHaveAttribute("href", "/workflows/" + workflowId + "/automations");
  expect(turn.queryByText(ignored)).toBeNull();
  click(text);
  expect(window.location.pathname).toBe(RUN_PATH);
  await expect(screen.findByText(old)).resolves.toBeInTheDocument();
  const pending = await screen.findByRole("listitem", {
    name: "Pending automation event",
  });
  expect(within(pending).getByText(waiting)).toBeInTheDocument();
  expect(screen.queryByRole("listitem", { name: "Queued message" })).toBeNull();
});

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

test("chat-composer-workflows-003 the first draft text loads workflows and their recent order once across searches", async () => {
  createChatRunFixtures(context).installRunChat();
  const first = context.mocks.deferred<void>();
  const requests: string[] = [];
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
      requests.push("for-composer");
      const result = available ? [entry] : [];
      await first.promise;
      return respond(200, result);
    },
  );
  context.mocks.api(workflowsCollectionContract.recent, ({ respond }) => {
    requests.push("recent");
    return respond(200, { workflowIds: [entry.id] });
  });
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByLabelText("Message");
  expect(requests).toStrictEqual([]);
  await fill(editor, "Draft");
  await waitFor(() => {
    expect([...requests].sort()).toStrictEqual(["for-composer", "recent"]);
  });
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
  expect([...requests].sort()).toStrictEqual(["for-composer", "recent"]);
});

test("chat-composer-workflows-007 selecting Morning brief sends the same workflow reference shown inline", async () => {
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest: (b) => {
      return sent.resolve(b.userMessage);
    },
  });
  await setupPage({ context, path: "/" });
  await screen.findByLabelText("Message");
  click(await findAction("button", "Advanced workflows"));
  click(await screen.findByText("Start your day with a clear plan"));
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent("Morning brief");
  });
  click(await findAction("button", "Send"));
  expect((await sent.promise)?.parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      titleSnapshot: "Morning brief",
      template: {
        type: "workflow",
        selection: {
          workflowTemplateId: "workflow-template:morning-brief",
        },
      },
    }),
  );
  const title = await screen.findByText("Morning brief", {
    selector: '[data-role="user"] [data-structured-template-reference] *',
  });
  expect(title).toBeVisible();
  expect(
    title.closest("[data-structured-template-reference]"),
  ).toHaveAccessibleDescription("Workflow · Morning brief");
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
