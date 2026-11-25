import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const INSTALL_URL = "https://slack.com/oauth/v2/authorize?client_id=okou";

function button(name: string, container: ParentNode): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

function slackCard(): HTMLElement {
  const card = [
    ...document.querySelectorAll<HTMLElement>('[data-slot="integration-card"]'),
  ].find((candidate) => {
    return candidate.textContent?.includes("Slack");
  });
  if (!card) {
    throw new Error("Expected the Slack card");
  }
  return card;
}

test("slack uninstall keeps confirmation while pending and recovers after failure", async () => {
  const server = { installed: true };
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: server.installed,
      isInstalled: server.installed,
      isAdmin: true,
      workspaceName: server.installed ? "Acme" : null,
      installUrl: INSTALL_URL,
    });
  });
  const firstAttempt = { pending: true };
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    integrationsSlackContract.disconnect,
    async ({ query, respond }) => {
      expect(query.action).toBe("uninstall");
      if (firstAttempt.pending) {
        firstAttempt.pending = false;
        requested.resolve();
        await release.promise;
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Uninstall unavailable" },
        });
      }
      server.installed = false;
      return respond(200, { ok: true });
    },
  );
  await setupPage({ context, path: "/works" });
  const options = await waitFor(() => {
    const found = button("More options", slackCard());
    expect(found).toBeDefined();
    return found as HTMLElement;
  });
  click(options);
  // The card's options open as a popover of actions.
  const uninstallItem = await waitFor(() => {
    const item = button("Uninstall", document.body);
    expect(item).toBeDefined();
    return item as HTMLElement;
  });
  click(uninstallItem);
  const dialog = await screen.findByRole("dialog", {
    name: "Uninstall Slack integration?",
  });
  const user = userEvent.setup({ delay: null });

  click(button("Uninstall", dialog) as HTMLElement);
  await requested.promise;

  await waitFor(() => {
    expect(button("Uninstalling…", dialog)).toBeDisabled();
  });
  expect(button("Cancel", dialog)).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(dialog).toBeInTheDocument();

  release.resolve();

  await expect(
    screen.findByText("Uninstall unavailable"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(button("Uninstall", dialog)).toBeEnabled();
  });

  click(button("Uninstall", dialog) as HTMLElement);

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(
      within(slackCard()).getByText("Install to Slack"),
    ).toBeInTheDocument();
  });
});
