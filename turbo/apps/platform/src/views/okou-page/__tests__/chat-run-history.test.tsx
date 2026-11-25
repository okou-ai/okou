import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow, now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  findEnabledButton,
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  promptEvent,
  usageEvent,
  creditUsage,
  RUN_PATH,
  queryButton,
} from "./chat-run-test-fixtures.ts";
const context = testContext();
function historyControls(pane: HTMLElement) {
  return queryAllByRoleFast("button", pane).filter((button) => {
    return /^(Expand|Collapse) work history$/u.test(
      button.getAttribute("aria-label") ?? "",
    );
  });
}
function input(runId: string, seqId: number, text: string, createdAt?: string) {
  return promptEvent({
    id: crypto.randomUUID(),
    runId,
    seqId,
    text,
    createdAt,
  });
}
function output(
  runId: string,
  seqId: number,
  text: string,
  createdAt?: string,
) {
  return assistantEvent({
    id: crypto.randomUUID(),
    runId,
    seqId,
    text,
    createdAt,
  });
}
function end(runId: string, seqId: number, createdAt?: string) {
  return completedEvent({ id: crypto.randomUUID(), runId, seqId, createdAt });
}
async function show(events: MockChatEventInput[], activeRunIds: string[] = []) {
  const service = createChatRunFixtures(context).installRunChat({
    chatEvents: events,
    activeRunIds,
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  return service;
}
function transcript(text: HTMLElement) {
  const pane = text.closest<HTMLElement>("[data-chat-thread-container-id]");
  if (!pane) {
    throw new Error("Expected message in conversation");
  }
  return pane;
}
test("chat-run-history-002 expanding the first outline reveals only its own work", async () => {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await show([
    input(first, 1, "Plan phase one"),
    output(first, 2, "Collected requirements"),
    output(first, 3, "Phase one outline"),
    input(first, 4, "Refine phase one"),
    output(first, 5, "Rechecked totals"),
    output(first, 6, "Phase one revision"),
    end(first, 7),
    input(second, 8, "Plan phase two"),
    output(second, 9, "Compared alternatives"),
    output(second, 10, "Phase two outline"),
    end(second, 11),
  ]);
  const anchor = await screen.findByText("Phase one outline");
  const pane = transcript(anchor);
  const toggle = queryAllByRoleFast("button", pane)
    .filter((el) => {
      return (
        el.getAttribute("aria-label") === "Expand work history" &&
        Boolean(
          el.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING,
        )
      );
    })
    .at(-1);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(pane).queryByText("Collected requirements")).toBeNull();
  click(toggle!);
  const step = await within(pane).findByText("Collected requirements");
  expect(
    within(pane).getByText("Plan phase one").compareDocumentPosition(step) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    step.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(pane).queryByText("Rechecked totals")).toBeNull();
  expect(within(pane).queryByText("Compared alternatives")).toBeNull();
});
test("chat-run-history-003 an active answer has one work label and thinking continues", async () => {
  const run = crypto.randomUUID();
  await show(
    [
      input(run, 1, "Check the first shipment"),
      output(run, 2, "Shipment A is accounted for"),
    ],
    [run],
  );
  const pane = transcript(
    await screen.findByText("Shipment A is accounted for"),
  );
  await waitFor(() => {
    expect(pane.querySelector("[data-thinking-indicator]")).toBeVisible();
    expect(within(pane).getAllByText(/^Working for /)).toHaveLength(1);
  });
  expect(historyControls(pane)).toHaveLength(0);
});
test("chat-run-history-010 queue time stays outside the running and final work durations", async () => {
  const old = crypto.randomUUID(),
    run = crypto.randomUUID();
  const finish = now();
  mockNow(finish, context.signal);
  const at = (minutesBefore: number) => {
    return new Date(finish - minutesBefore * 60_000).toISOString();
  };
  const queued = {
    ...input(run, 4, "Review the queue ledger", at(132 + 40 / 60)),
    runId: undefined,
  };
  const service = await show(
    [
      input(old, 1, "Audit invoices", at(312)),
      output(old, 2, "Invoice audit ready", at(230)),
      end(old, 3, at(228)),
      queued,
      {
        ...input(run, 5, "Review the queue ledger", at(72)),
        revokesEventId: queued.id,
      },
      output(run, 6, "Reading entries", at(69)),
    ],
    [run],
  );
  const currentOutput = await screen.findByText("Reading entries");
  const view = within(transcript(currentOutput));
  function durationsInTurn(prompt: string, answer: HTMLElement) {
    const start = view.getByText(prompt);
    return view
      .queryAllByText(/^(Working|Worked) for /)
      .filter((label) => {
        return (
          Boolean(
            start.compareDocumentPosition(label) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ) &&
          Boolean(
            label.compareDocumentPosition(answer) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          )
        );
      })
      .map((label) => {
        return label.textContent;
      });
  }
  await waitFor(() => {
    expect(
      durationsInTurn("Review the queue ledger", currentOutput),
    ).toStrictEqual(["Working for 1 hr 12 min"]);
  });
  expect(
    durationsInTurn("Audit invoices", view.getByText("Invoice audit ready")),
  ).toStrictEqual(["Worked for 1 hr 24 min"]);
  service.completeRun();
  await waitFor(() => {
    expect(
      durationsInTurn(
        "Review the queue ledger",
        view.getByText("Reading entries"),
      ),
    ).toStrictEqual(["Worked for 1 hr 12 min"]);
  });
  expect(
    durationsInTurn("Audit invoices", view.getByText("Invoice audit ready")),
  ).toStrictEqual(["Worked for 1 hr 24 min"]);
});
test("chat-run-history-012 a pending request has no work duration or history yet", async () => {
  const run = crypto.randomUUID();
  await show([input(run, 1, "Calculate supplier balances")], [run]);
  const pane = transcript(
    await screen.findByText("Calculate supplier balances"),
  );
  await waitFor(() => {
    expect(pane.querySelector("[data-thinking-indicator]")).toBeVisible();
  });
  expect(within(pane).queryByText(/^(Working|Worked) for /)).toBeNull();
  expect(historyControls(pane)).toHaveLength(0);
});
test("chat-run-history-018 the waiting turn has no result actions", async () => {
  const run = crypto.randomUUID();
  await show([input(run, 1, "Price the returned stock")], [run]);
  const pane = transcript(await screen.findByText("Price the returned stock"));
  await waitFor(() => {
    expect(pane.querySelector("[data-thinking-indicator]")).toBeVisible();
  });
  expect(within(pane).queryByTestId("chat-event-actions")).toBeNull();
});
test("chat-run-history-015 only the fifth result remains visible after the audit completes", async () => {
  const run = crypto.randomUUID(),
    notes = [
      "Extract quantities",
      "Match vendor",
      "Compare freight",
      "Verify tax",
      "Invoice reconciled",
    ];
  await show([
    input(run, 1, "Review invoice"),
    ...notes.map((note, i) => {
      return output(run, i + 2, note);
    }),
    end(run, 7),
  ]);
  const pane = transcript(await screen.findByText("Invoice reconciled"));
  const view = within(pane);
  expect(view.getAllByText(/^Worked for /)).toHaveLength(1);
  const controls = historyControls(pane);
  expect(controls).toHaveLength(1);
  expect(controls[0]).toHaveAttribute("aria-expanded", "false");
  expect(pane.querySelector("[data-thinking-indicator]")).toBeNull();
  for (const note of notes.slice(0, 4)) {
    expect(view.queryByText(note)).toBeNull();
  }
});
test("chat-run-history-021 the finished answer excludes the run's budget instruction", async () => {
  const run = crypto.randomUUID(),
    notice = "You have 12 minutes left in this run";
  await show([
    input(run, 1, "Report the balance"),
    { ...input(run, 2, notice), eventType: "input.budget" },
    output(run, 3, "Closing balance is forty"),
    end(run, 4),
  ]);
  const pane = transcript(await screen.findByText("Closing balance is forty"));
  expect(within(pane).getByText("Report the balance")).toBeInTheDocument();
  expect(within(pane).queryByText(notice)).toBeNull();
});
test("chat-run-history-022 a settled zero-credit event leaves an idle composer", async () => {
  const run = crypto.randomUUID();
  await show([
    usageEvent({
      id: crypto.randomUUID(),
      seqId: 1,
      runId: run,
      usage: creditUsage(0, []),
    }),
  ]);
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const pane = transcript(composer);
  await within(pane).findByRole("group", { name: "Explore Okou capabilities" });
  expect(queryButton("Send", pane)).toBeVisible();
  expect(queryButton("Stop", pane)).toBeNull();
  expect(queryButton("Credit usage", pane)).toBeNull();
  expect(within(pane).queryByText(/credits? used/i)).toBeNull();
});
test("chat-run-history-023 the submitted markup is literal text next to its answer", async () => {
  const literal = "<span> 123 </span>";
  const service = await show([]);
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await fill(editor, literal);
  click(await findEnabledButton("Send"));
  await screen.findByText(literal, { selector: '[data-role="user"] *' });
  service.completeRun("Copied your example");
  const view = within(
    transcript(await screen.findByText("Copied your example")),
  );
  expect(view.getByText(literal)).toBeVisible();
});
