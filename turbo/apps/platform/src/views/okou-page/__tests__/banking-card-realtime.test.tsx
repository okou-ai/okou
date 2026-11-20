import { bankingUserContract } from "@okouai/api-contracts/contracts/banking";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000071";
const REASON = "Review quarterly subscription expenses";

test("Duplicate banking cards update together on events and recover after a continuity gap", async () => {
  const chat = createMarkdownChatFixture(context);
  const url = new URL(`https://app.okou.ai/agents/${AGENT_ID}/banking`);
  url.searchParams.set("reason", REASON);
  url.searchParams.set("threadId", context.resourceId);
  url.searchParams.set("callbackPrompt", "Continue the expense review");
  let name = "Finance Assistant";
  context.mocks.api(bankingUserContract.accessRequestStatus, ({ respond }) => {
    return respond(200, {
      agent: { id: AGENT_ID, name },
      connection: null,
      session: null,
      grant: null,
    });
  });
  chat.install({
    rows: () => {
      return [
        chat.outputMessage(`${url.toString()}\n\n${url.toString()}`, {
          seqId: 1,
        }),
        chat.runCompleted({ seqId: 2 }),
      ];
    },
  });
  const attachment = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "bankingAccessChanged",
  );
  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    sharedWorkerTestTransport: "message-port",
  });
  await waitFor(() => {
    expect(screen.getAllByTestId("banking-action-card")).toHaveLength(2);
    expect(screen.getAllByText(name)).toHaveLength(2);
  });
  await attachment.started;
  name = "Updated Finance Assistant";
  attachment.attach();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("bankingAccessChanged"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("bankingAccessChanged", {});
  await waitFor(() => {
    expect(screen.getAllByText(name)).toHaveLength(2);
  });

  context.mocks.ably.triggerConnectionState("suspended");
  name = "Recovered Finance Assistant";
  context.mocks.ably.triggerConnectionState("connected");
  await waitFor(() => {
    expect(screen.getAllByText(name)).toHaveLength(2);
  });
});
