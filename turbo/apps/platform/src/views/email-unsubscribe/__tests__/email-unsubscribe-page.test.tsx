import { emailUnsubscribeContract } from "@okouai/api-contracts/contracts/email-unsubscribe";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function visit(token?: string) {
  const address = new URL("/email/unsubscribe", "https://app.okou.ai");
  if (token) {
    address.searchParams.set("token", token);
  }
  await setupPage({
    context,
    host: address.hostname,
    path: address.pathname + address.search,
    auth: null,
  });
}
test("email-unsubscribe-page-002 displays the branded error immediately for a signed-out visitor without a token", async () => {
  await visit();
  const problem = await screen.findByRole("alert");
  expect(problem).toHaveTextContent("Something went wrong");
  expect(screen.getByRole("img", { name: "Okou" })).toBeInTheDocument();
  expect(queryAllByRoleFast("button")).toHaveLength(0);
});
async function confirmLink(token: string) {
  context.mocks.api(
    emailUnsubscribeContract.unsubscribe,
    ({ query, respond }) => {
      if (query.token === "current-notification-link") {
        return respond(200, { unsubscribed: true });
      }
      return respond(400, { error: "Invalid subscription token" });
    },
  );
  await visit(token);
  const confirm = await screen.findByText("Unsubscribe", {
    selector: "button",
  });
  expect(confirm).toBeEnabled();
  click(confirm);
}
test("email-unsubscribe-page-001 reports an invalid notification token after confirmation", async () => {
  await confirmLink("expired-notification-link");
  const problem = await screen.findByRole("alert");
  expect(within(problem).getByText("Something went wrong")).toBeVisible();
});
test("email-unsubscribe-page-003 confirms that system notifications are unsubscribed", async () => {
  await confirmLink("current-notification-link");
  const receipt = await screen.findByRole("heading", { name: "Unsubscribed" });
  expect(receipt.parentElement).toHaveTextContent(
    "You will no longer receive system-initiated email notifications from Okou.",
  );
});
