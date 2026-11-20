import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";
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

test("a member runs a real brief, sees its conversation link and requests another", async () => {
  const ids: string[] = [];
  context.mocks.api(debugMorningBriefContract.run, ({ body, respond }) => {
    ids.push(body.requestId);
    return respond(200, {
      requestId: body.requestId,
      status: "completed",
      chatThreadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });
  await openDebug();
  const send = button("Run Morning Brief");
  await waitFor(() => {
    return expect(send).toBeEnabled();
  });
  click(send);
  await screen.findByText("Morning Brief completed.");
  expect(
    screen.getByText(/Your daily schedule stays unchanged/u),
  ).toBeInTheDocument();
  const conversation = queryAllByRoleFast("link").find((link) => {
    return link.textContent?.trim() === "Open chat";
  });
  expect(conversation).toHaveAttribute(
    "href",
    "/chats/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  click(button("Run another Morning Brief"));
  await waitFor(() => {
    return expect(ids).toHaveLength(2);
  });
  expect(new Set(ids).size).toBe(2);
});

test("reports a failed run with its conversation for details", async () => {
  context.mocks.api(debugMorningBriefContract.run, ({ body, respond }) => {
    return respond(200, {
      requestId: body.requestId,
      status: "failed",
      chatThreadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId: null,
    });
  });
  await openDebug();
  const run = button("Run Morning Brief");
  await waitFor(() => {
    return expect(run).toBeEnabled();
  });
  click(run);
  await screen.findByText("Morning Brief failed. Open the chat for details.");
  expect(button("Run another Morning Brief")).toBeEnabled();
});

test("supports keyboard activation with one submission", async () => {
  let requests = 0;
  context.mocks.api(debugMorningBriefContract.run, ({ body, respond }) => {
    requests += 1;
    return respond(200, {
      requestId: body.requestId,
      status: "completed",
      chatThreadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });
  await openDebug();
  const send = button("Run Morning Brief");
  await waitFor(() => {
    expect(send).toBeEnabled();
  });
  send.focus();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Enter}");
  await screen.findByText("Morning Brief completed.");
  expect(requests).toBe(1);
});
