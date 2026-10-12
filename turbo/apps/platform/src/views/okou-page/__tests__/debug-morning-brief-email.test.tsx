import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { debugMorningBriefEmailContract } from "@okouai/api-contracts/contracts/debug-morning-brief-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
function button(name: string) {
  const found = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!found) {
    throw new Error(`Expected button ${name}`);
  }
  return found;
}
async function openDebug(debug = true) {
  await setupPage({
    context,
    path: "/agents?settings=debug",
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: debug,
    },
  });
  await screen.findByRole("heading", { name: debug ? "Debug" : "Preference" });
}

test("a member sends a sample and sees provider acceptance, then explicitly requests another", async () => {
  const ids: string[] = [];
  context.mocks.api(
    debugMorningBriefEmailContract.send,
    ({ body, respond }) => {
      ids.push(body.requestId);
      return respond(200, {
        requestId: body.requestId,
        status: "sent",
        reason: null,
      });
    },
  );
  await openDebug();
  const send = button("Send test email");
  await waitFor(() => {
    return expect(send).toBeEnabled();
  });
  click(send);
  await screen.findByText(/Accepted by the email provider/u);
  expect(
    screen.getByText(/does not run an Agent or change your schedule/u),
  ).toBeInTheDocument();
  click(button("Send another test email"));
  await waitFor(() => {
    return expect(ids).toHaveLength(2);
  });
  expect(new Set(ids).size).toBe(2);
});

test("keeps the same request ID after a failed HTTP request", async () => {
  const ids: string[] = [];
  context.mocks.api(
    debugMorningBriefEmailContract.send,
    ({ body, respond }) => {
      ids.push(body.requestId);
      return ids.length === 1
        ? respond(503, {
            error: {
              code: "NOT_CONFIGURED",
              message: "Email delivery unavailable",
            },
          })
        : respond(200, {
            requestId: body.requestId,
            status: "sent",
            reason: null,
          });
    },
  );
  await openDebug();
  const send = button("Send test email");
  await waitFor(() => {
    return expect(send).toBeEnabled();
  });
  click(send);
  await screen.findByText(/The request did not finish/u);
  click(button("Retry test email"));
  await screen.findByText(/Accepted by the email provider/u);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

test("shows queued state and checks the same receipt before allowing another sample", async () => {
  let requestId = "";
  context.mocks.api(
    debugMorningBriefEmailContract.send,
    ({ body, respond }) => {
      requestId = body.requestId;
      return respond(200, { requestId, status: "queued", reason: null });
    },
  );
  context.mocks.api(
    debugMorningBriefEmailContract.get,
    ({ params, respond }) => {
      expect(params.id).toBe(requestId);
      return respond(200, { requestId, status: "sent", reason: null });
    },
  );
  await openDebug();
  const send = button("Send test email");
  await waitFor(() => {
    return expect(send).toBeEnabled();
  });
  click(send);
  await screen.findByText(/Queued for delivery/u);
  expect(button("Send another test email")).toBeDisabled();
  click(button("Check delivery status"));
  await screen.findByText(/Accepted by the email provider/u);
  expect(button("Send another test email")).toBeEnabled();
});

test("explains unsubscribe skips without claiming an email was sent", async () => {
  context.mocks.api(
    debugMorningBriefEmailContract.send,
    ({ body, respond }) => {
      return respond(200, {
        requestId: body.requestId,
        status: "skipped",
        reason: "unsubscribed",
      });
    },
  );
  await openDebug();
  const send = button("Send test email");
  await waitFor(() => {
    return expect(send).toBeEnabled();
  });
  click(send);
  await screen.findByText(
    "Skipped: your account is unsubscribed from email updates.",
  );
  expect(
    screen.queryByText(/Accepted by the email provider/u),
  ).not.toBeInTheDocument();
});

test("hides the test action without Okou Debug", async () => {
  context.mocks.api(debugMorningBriefEmailContract.send, () => {
    throw new Error("Hidden action must not send");
  });
  await openDebug(false);
  expect(
    screen.queryByText("Morning Brief test email"),
  ).not.toBeInTheDocument();
});

test("supports keyboard activation with one submission", async () => {
  let requests = 0;
  context.mocks.api(
    debugMorningBriefEmailContract.send,
    ({ body, respond }) => {
      requests += 1;
      return respond(200, {
        requestId: body.requestId,
        status: "sent",
        reason: null,
      });
    },
  );
  await openDebug();
  const send = button("Send test email");
  await waitFor(() => {
    expect(send).toBeEnabled();
  });
  send.focus();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Enter}");
  await screen.findByText(/Accepted by the email provider/u);
  expect(requests).toBe(1);
});

test("dismissal cancels a pending request before the Settings closing animation", async () => {
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  let requestSignal: AbortSignal | undefined;
  context.mocks.api(
    debugMorningBriefEmailContract.send,
    async ({ body, request, respond }) => {
      requestSignal = request.signal;
      requested.resolve();
      await response.promise;
      return respond(200, {
        requestId: body.requestId,
        status: "sent",
        reason: null,
      });
    },
  );
  await openDebug();
  const send = button("Send test email");
  await waitFor(() => {
    expect(send).toBeEnabled();
  });
  click(send);
  await requested.promise;
  expect(button("Sending…")).toBeDisabled();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(requestSignal?.aborted).toBeTruthy();
  });
  response.resolve();
});
