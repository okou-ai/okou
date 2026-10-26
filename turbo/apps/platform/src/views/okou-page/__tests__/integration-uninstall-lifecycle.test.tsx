import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
  mockSlack,
  mockTeams,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

test.each(["slack", "teams"] as const)(
  "%s uninstall keeps confirmation while pending and recovers after failure",
  async (platform) => {
    const name = platform === "slack" ? "Slack" : "Microsoft Teams";
    mockSlack(context, {
      isInstalled: true,
      isConnected: true,
      isAdmin: true,
      installUrl: "https://slack.example.test/install",
    });
    mockTeams(context, { isInstalled: true, isAdmin: true });
    const started = context.mocks.deferred<void>();
    const response = context.mocks.deferred<void>();
    let fail = true;
    if (platform === "slack") {
      context.mocks.api(
        integrationsSlackContract.disconnect,
        async ({ respond }) => {
          if (fail) {
            started.resolve();
            await response.promise;
            return respond(403, {
              error: { code: "FORBIDDEN", message: "Uninstall unavailable" },
            });
          }
          mockSlack(context, {
            isAdmin: true,
            installUrl: "https://slack.example.test/install",
          });
          return respond(200, { ok: true });
        },
      );
    } else {
      context.mocks.api(
        teamsConnectContract.disconnect,
        async ({ respond }) => {
          if (fail) {
            started.resolve();
            await response.promise;
            return respond(403, {
              error: { code: "FORBIDDEN", message: "Uninstall unavailable" },
            });
          }
          mockTeams(context, { isInstalled: false, isAdmin: true });
          return respond(200, { success: true });
        },
      );
    }
    await setupIntegrationsPage(context);
    await screen.findByText(name);
    click(
      getAction(
        "button",
        platform === "slack" ? "More options" : `More ${name} options`,
        getIntegrationCard(name),
      ),
    );
    click(
      getAction(
        "button",
        platform === "slack" ? "Uninstall" : `Uninstall ${name}`,
      ),
    );
    const dialog = await screen.findByRole("dialog", {
      name: `Uninstall ${name} integration?`,
    });
    click(getAction("button", "Uninstall", dialog));
    await started.promise;
    expect(getAction("button", "Cancel", dialog)).toBeDisabled();
    expect(getAction("button", "Uninstalling…", dialog)).toBeDisabled();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    response.resolve();
    await screen.findByText("Uninstall unavailable");
    expect(getAction("button", "Uninstall", dialog)).toBeEnabled();
    fail = false;
    click(getAction("button", "Uninstall", dialog));
    await waitFor(() => {
      expect(
        getAction(
          "button",
          platform === "slack" ? "Install to Slack" : "Install in Teams",
          getIntegrationCard(name),
        ),
      ).toBeEnabled();
    });
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
  },
);
