import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { sessionOutputChannelName } from "@okouai/api-contracts/validators/realtime";
import { act, screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  findEnabledButton,
  promptEvent,
  assistantEvent,
  completedEvent,
  RUN_THREAD_ID,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();

async function conversation() {
  const user = { id: "harbor-reader", fullName: "Harbor Reader" };
  const org = { id: "org_harbor", name: "Harbor" };
  const run = crypto.randomUUID(),
    event = crypto.randomUUID();
  const channel = sessionOutputChannelName(user.id, org.id, run);
  const events = [
    promptEvent({
      id: crypto.randomUUID(),
      seqId: 1,
      text: "Prepare the report",
      runId: run,
    }),
  ];
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    activeRunIds: [run],
    chatEvents: events,
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    auth: {
      user,
      organization: { activeOrg: org, memberships: [{ id: org.id }] },
    },
  });
  await screen.findByText("Prepare the report");
  const subscribed = () => {
    return context.mocks.ably.hasSubscriptionOnChannel(channel, run);
  };
  await waitFor(() => {
    expect(subscribed()).toBeTruthy();
  });
  let index = 0;
  const createdAt = "2026-08-01T10:00:02.000Z";
  return {
    subscribed,
    chunk(delta: string) {
      context.mocks.ably.triggerOnChannel(channel, run, {
        threadId: RUN_THREAD_ID,
        runId: run,
        eventId: event,
        runEventId: "report-event",
        createdAt,
        chunkIndex: index++,
        delta,
      });
    },
    nextBlock(text: string) {
      context.mocks.ably.triggerOnChannel(channel, run, {
        threadId: RUN_THREAD_ID,
        runId: run,
        eventId: crypto.randomUUID(),
        runEventId: crypto.randomUUID(),
        createdAt: "2026-08-01T10:00:03.000Z",
        chunkIndex: 0,
        delta: text,
      });
    },
    persist(text: string) {
      events.push(
        assistantEvent({ id: event, runId: run, seqId: 2, text, createdAt }),
      );
      createChatEvent(RUN_THREAD_ID);
    },
    finish() {
      events.push(
        completedEvent({ id: crypto.randomUUID(), runId: run, seqId: 3 }),
      );
      createChatEvent(RUN_THREAD_ID);
    },
  };
}
const url = "https://app.okou.ai/computer-use/authorize/harbor-report";
const card = () => {
  return screen.findByTestId("computer-use-authorization-card");
};
test("chat-session-output-stream-004 the same authorization card survives added paragraphs and finalization", async () => {
  const api = await conversation();
  api.chunk(url + " ");
  const request = await card();
  api.chunk("Review this request.");
  await screen.findByText(/Review this request/);
  await expect(card()).resolves.toBe(request);
  api.chunk("\n\nWork can continue.");
  await screen.findByText("Work can continue.");
  await expect(card()).resolves.toBe(request);
  api.persist(url + " Review this request.\n\nWork can continue.");
  api.finish();
  await waitFor(() => {
    expect(api.subscribed()).toBeFalsy();
  });
  await expect(card()).resolves.toBe(request);
});
test("chat-session-output-stream-006 closing a Markdown link presents authorization during the active run", async () => {
  const api = await conversation();
  api.chunk("[Review access](" + url);
  await screen.findByText(/Review access/);
  expect(screen.queryByTestId("computer-use-authorization-card")).toBeNull();
  api.chunk(")");
  await expect(card()).resolves.toBeVisible();
  expect(screen.getAllByTestId("computer-use-authorization-card")).toHaveLength(
    1,
  );
  expect(api.subscribed()).toBeTruthy();
});
test("chat-session-output-stream-009 the approval destination includes its final signature underscore", async () => {
  const api = await conversation();
  const link = "https://app.link.com/approve/harbor?signature=abc";
  api.chunk(link);
  await screen.findByText(link);
  api.chunk("_ ");
  const purchase = await findFastControl("link", "Review purchase");
  expect(purchase).toHaveAttribute("href", link + "_");
  api.chunk("Review the order details.");
  await screen.findByText(/Review the order details/);
});
test("chat-session-output-stream-011 completing the run ends its live subscription after displaying the durable report", async () => {
  const api = await conversation();
  api.persist("The complete report");
  await screen.findByText("The complete report");
  expect(api.subscribed()).toBeTruthy();
  api.finish();
  await waitFor(() => {
    expect(api.subscribed()).toBeFalsy();
  });
  expect(screen.getByText("The complete report")).toBeVisible();
});

test("chat-session-output-stream-010 closing the streamed PDF embed reveals its preview through completion", async () => {
  const wire = await conversation();
  const open = "![Port survey](https://a.okou.io/harbor7pdf.pdf";
  wire.chunk(open);
  await screen.findByText(/Port survey/);
  const preview = "Open pdf preview for harbor7pdf.pdf";
  expect(screen.queryByLabelText(preview)).not.toBeInTheDocument();
  wire.chunk(")");
  await expect(screen.findByLabelText(preview)).resolves.toBeInTheDocument();
  wire.persist(open + ")\n\nSurvey delivered.");
  wire.finish();
  await screen.findByText("Survey delivered.");
  expect(screen.getByLabelText(preview)).toBeInTheDocument();
});

test.each([
  ["session-output-stream-002", "delivered"],
  ["Withheld control", "withheld"],
] as const)(
  "%s The replacement run keeps streaming in the same conversation with the old attach %s",
  async (_case, schedule) => {
    const first = crypto.randomUUID();
    const member = "expense-reader",
      org = "expense-group";
    const channel = (id: string) => {
      return sessionOutputChannelName(member, org, id);
    };
    const obsolete = context.mocks.ably.deferSubscribeOnChannel(
      channel(first),
      first,
    );
    let attached = false;
    function finishAttachment() {
      if (!attached) {
        attached = true;
        obsolete.attach();
      }
    }
    const next = context.mocks.deferred<string>();
    const lifecycle = mockChatLifecycle(context, {
      onRunCreate(_body, runId) {
        next.resolve(runId);
      },
      threadId: RUN_THREAD_ID,
      activeRunIds: [first],
      chatEvents: [
        promptEvent({
          id: crypto.randomUUID(),
          seqId: 1,
          text: "Review invoice batch",
          runId: first,
        }),
      ],
    });
    try {
      await setupPage({
        context,
        path: RUN_PATH,
        auth: {
          user: { id: member, fullName: "Member" },
          organization: {
            activeOrg: { id: org, name: "Billing" },
            memberships: [{ id: org }],
          },
        },
      });
      await screen.findByText("Review invoice batch");
      await obsolete.started;
      lifecycle.completeRun("Invoice list complete");
      await screen.findByText("Invoice list complete");
      await fill(await findComposerEditor(), "Review the outstanding receipts");
      click(await findEnabledButton("Send"));
      const second = await next.promise;
      await waitFor(() => {
        return expect(
          context.mocks.ably.hasSubscriptionOnChannel(channel(second), second),
        ).toBeTruthy();
      });
      const emit = (id: string, index: number, text: string) => {
        context.mocks.ably.triggerOnChannel(channel(id), id, {
          threadId: RUN_THREAD_ID,
          runId: id,
          eventId: id,
          runEventId: "receipt",
          createdAt: "2026-11-03T11:00:00Z",
          chunkIndex: index,
          delta: text,
        });
      };
      if (schedule === "delivered") {
        finishAttachment();
      }
      await waitFor(() => {
        return expect(obsolete.completed()).toBe(schedule === "delivered");
      });
      emit(second, 0, "The invoice will ");
      await screen.findByText("The invoice will");
      expect(obsolete.completed()).toBe(schedule === "delivered");
      await waitFor(() => {
        return expect(
          context.mocks.ably.hasSubscriptionOnChannel(channel(first), first),
        ).toBeFalsy();
      });
      emit(first, 0, "Superseded old content");
      emit(second, 1, "settle tomorrow.");
      await screen.findByText("The invoice will settle tomorrow.");
      expect(screen.queryByText("Superseded old content")).toBeNull();
      expect(obsolete.completed()).toBe(schedule === "delivered");
      expect(
        context.mocks.ably.hasSubscriptionOnChannel(channel(second), second),
      ).toBeTruthy();
      click(await findFastControl("link", /^New chat/));
      await waitFor(() => {
        return expect(window.location.pathname).toBe("/");
      });
      await waitFor(() => {
        return expect(
          context.mocks.ably.hasSubscriptionOnChannel(channel(second), second),
        ).toBeFalsy();
      });
    } finally {
      finishAttachment();
    }
  },
);

test("A returning conversation reacquires live output after its reader left for Workflows", async () => {
  const session = await conversation();
  session.chunk("Ready at platform nine.");
  await screen.findByText("Ready at platform nine.");
  click(await findFastControl("link", "Workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  await waitFor(() => {
    return expect(session.subscribed()).toBeFalsy();
  });
  window.history.back();
  await screen.findByText("Prepare the report");
  await waitFor(() => {
    return expect(session.subscribed()).toBeTruthy();
  });
  session.nextBlock("Depart from platform four.");
  await screen.findByText("Depart from platform four.");
  await expect(findComposerEditor()).resolves.toBeEnabled();
});

async function pendingReport() {
  const events = await conversation();
  events.chunk("Preparing the report.");
  await screen.findByText("Preparing the report.");
  return events;
}

test("chat-session-output-stream-002 A durable report ignores a late live fragment before completion", async () => {
  const events = await pendingReport();
  events.persist("The complete report");
  await screen.findByText("The complete report");
  act(() => {
    return events.chunk(" Additional figures.");
  });
  expect(screen.getByText("The complete report")).toBeInTheDocument();
  expect(screen.queryByText(/Additional figures/)).not.toBeInTheDocument();
  events.finish();
  await waitFor(() => {
    return expect(events.subscribed()).toBeFalsy();
  });
  expect(screen.getAllByText("The complete report")).toHaveLength(1);
  expect(
    screen.queryByText(/Preparing the report|Additional figures/),
  ).not.toBeInTheDocument();
});

test("Without a durable event the late fragment extends the visible report", async () => {
  const events = await pendingReport();
  events.chunk(" Additional figures.");
  await expect(
    screen.findByText("Preparing the report. Additional figures."),
  ).resolves.toBeVisible();
});

test("A partial authorization URL can already be followed before the terminating space", async () => {
  const events = await conversation();
  const prefix = "https://app.okou.ai/computer-use/authorize/";
  events.chunk(prefix + "harbor");
  const early = await findFastControl("link", prefix + "harbor");
  expect(early).toHaveAttribute("href", prefix + "harbor");
  expect(
    screen.queryByTestId("computer-use-authorization-card"),
  ).not.toBeInTheDocument();
  events.chunk("-report.");
  await expect(findFastControl("link", url)).resolves.toHaveAttribute(
    "href",
    url,
  );
  expect(
    screen.queryByTestId("computer-use-authorization-card"),
  ).not.toBeInTheDocument();
  events.chunk(" Continue here.");
  await card();
  expect(screen.getAllByTestId("computer-use-authorization-card")).toHaveLength(
    1,
  );
  events.persist(url + ". Continue here.");
  events.finish();
  await waitFor(() => {
    return expect(events.subscribed()).toBeFalsy();
  });
  await screen.findByText(/Continue here/);
  expect(screen.getAllByTestId("computer-use-authorization-card")).toHaveLength(
    1,
  );
});

const delivery = "Message delivered without a Run";
test("chat-runless-delivery-001 an assistant delivery with no Run opens in its own conversation", async () => {
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        createdAt: "2026-08-01T10:01:00Z",
        id: "local-delivery",
        role: "assistant",
        content: delivery,
        runId: undefined,
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await expect(screen.findByText(delivery)).resolves.toBeInTheDocument();
});
test("chat-runless-delivery-003 only the earlier completed response offers its work history", async () => {
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        createdAt: "2026-08-01T10:00:00Z",
        id: "q",
        role: "user",
        content: "Review launch",
        runId: "local-run",
      },
      {
        createdAt: "2026-08-01T10:00:04Z",
        id: "step",
        role: "assistant",
        content: "Inspecting launch notes",
        runId: "local-run",
      },
      {
        createdAt: "2026-08-01T10:00:20Z",
        id: "completed",
        role: "assistant",
        content: "Launch review completed",
        runId: "local-run",
        runLifecycleEvent: "completed",
      },
      {
        createdAt: "2026-08-01T10:01:00Z",
        id: "followup",
        role: "assistant",
        content: delivery,
        runId: undefined,
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const earlier = await screen.findByText("Launch review completed");
  const later = await screen.findByText(delivery);
  expect(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const response =
    earlier.closest("[data-chat-message-anchor]") ??
    earlier.closest("[data-role=assistant]")!;
  const followup = later.closest("[data-role=assistant]")!;
  expect(response).not.toContainElement(later);
  expect(
    response.querySelector('[aria-label*="work history" i]'),
  ).toBeInTheDocument();
  expect(followup.querySelector('[aria-label*="work history" i]')).toBeNull();
});
