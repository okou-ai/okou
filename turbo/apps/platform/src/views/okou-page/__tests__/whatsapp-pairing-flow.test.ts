import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { integrationsWhatsappContract } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function pairing() {
  let paired = false;
  const agentPhoneNumber = "+12025550199";
  context.mocks.api(
    integrationsWhatsappContract.getLinkStatus,
    ({ respond }) => {
      return paired
        ? respond(200, {
            configured: true,
            agentPhoneNumber,
            linked: true,
            phoneHandle: "+4915123456789",
          })
        : respond(200, { configured: true, agentPhoneNumber, linked: false });
    },
  );
  context.mocks.api(
    integrationsWhatsappContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code: "12345678",
        expiresAt: "2027-01-10T09:10:00Z",
      });
    },
  );
  context.mocks.api(integrationsWhatsappContract.unlink, ({ respond }) => {
    paired = false;
    return respond(204);
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: true },
  });
  const button = await findFastControl("button", "Connect WhatsApp");
  await waitFor(() => {
    return expect(button).toBeEnabled();
  });
  return {
    button,
    link() {
      paired = true;
      triggerAblyEvent("agentphone:changed");
    },
  };
}
test("whatsapp-001 Pairing instructions lead to the verified account and disconnect restores the connect action", async () => {
  const w = await pairing();
  click(w.button);
  const dialog = await screen.findByRole("dialog");
  const view = within(dialog);
  await view.findByText("12345678");
  const destination = "https://wa.me/12025550199?text=12345678";
  expect(view.getByText("Open WhatsApp").closest("a")).toHaveAttribute(
    "href",
    destination,
  );
  expect(view.getByLabelText("Scan to connect WhatsApp")).toHaveAttribute(
    "data-whatsapp-href",
    destination,
  );
  expect(view.getByText(/Meta's policies/)).toBeInTheDocument();
  w.link();
  await screen.findByText(/Connected.*4915123456789/);
  expect(dialog).not.toBeInTheDocument();
  click(await findFastControl("button", "WhatsApp options"));
  click(await screen.findByText("Disconnect", { exact: true }));
  await expect(
    findFastControl("button", "Connect WhatsApp"),
  ).resolves.toBeEnabled();
});
test("whatsapp-003 Escape returns keyboard focus from the link code to Connect WhatsApp", async () => {
  const { button } = await pairing();
  const user = userEvent.setup({ delay: null });
  button.focus();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("12345678");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(button).toHaveFocus();
});
