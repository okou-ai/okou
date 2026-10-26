import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrants,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { customConnectorByIdContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  customConnectorAccount,
  getConnectorAction,
  listAgent,
  mockCustomConnectorStory,
  mockConnectorAgentAccess,
} from "./connector-page-test-helpers.ts";
const context = testContext();
const RESEARCH_ID = "c0000000-0000-4000-a000-000000000051";
const SUPPORT_ID = "c0000000-0000-4000-a000-000000000052";
test("Closing a pending permission save preserves another agent's permission draft", async () => {
  const connector = customConnector({
    permissionBundleRef: "builtin:feishu@1",
  });
  mockCustomConnectorStory(context, [
    {
      connector,
      account: customConnectorAccount(connector.id, {
        configuredFieldKeys: ["secret"],
      }),
    },
  ]);
  context.mocks.data.agents([
    listAgent(RESEARCH_ID, "Research"),
    listAgent(SUPPORT_ID, "Support"),
  ]);
  const grant = {
    customConnectorId: connector.id,
    permissionNames: ["messages:send-as-user"],
  };
  const access = new Map<string, AgentCustomConnectorGrants>([
    [RESEARCH_ID, { grants: [grant] }],
    [SUPPORT_ID, { grants: [grant] }],
  ]);
  context.mocks.api(
    agentCustomConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, access.get(params.id) ?? { grants: [] });
    },
  );
  mockConnectorAgentAccess(context, (agentId) => {
    return access.get(agentId) ?? { grants: [] };
  });
  context.mocks.api(customConnectorByIdContract.permissions, ({ respond }) => {
    return respond(200, {
      ref: "builtin:feishu@1",
      permissions: [
        {
          name: "messages:send-as-user",
          description: "Send messages as the connected user.",
        },
      ],
      defaultPolicies: { "messages:send-as-user": "deny" },
    });
  });
  const started = context.mocks.deferred<AbortSignal>();
  const firstResponse = context.mocks.deferred<void>();
  const serverCompleted = context.mocks.deferred<void>();
  context.mocks.api(
    agentCustomConnectorsContract.update,
    async ({ params, body, request, respond }) => {
      if (params.id === RESEARCH_ID) {
        started.resolve(request.signal);
        await firstResponse.promise;
        serverCompleted.resolve();
      }
      const grants = { grants: body.grants };
      access.set(params.id, grants);
      return respond(200, grants);
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  await waitFor(() => {
    return expect(
      getConnectorAction("button", "Manage Acme Search access"),
    ).toBeEnabled();
  });
  click(getConnectorAction("button", "Manage Acme Search access"));
  const accessDialog = await screen.findByRole("dialog", {
    name: "Manage Acme Search access",
  });
  await waitFor(() => {
    return expect(
      getConnectorAction(
        "button",
        "Manage Acme Search permissions for Research",
        accessDialog,
      ),
    ).toBeEnabled();
  });
  click(
    getConnectorAction(
      "button",
      "Manage Acme Search permissions for Research",
      accessDialog,
    ),
  );
  const first = await screen.findByRole("dialog", {
    name: "Acme Search permissions for Research",
  });
  await within(first).findByText("messages:send-as-user");
  click(getConnectorAction("button", "Deny", first));
  click(getConnectorAction("button", "Apply", first));
  const requestSignal = await started.promise;
  click(getConnectorAction("button", "Close", first));
  await waitFor(() => {
    return expect(first).not.toBeInTheDocument();
  });
  expect(requestSignal.aborted).toBeTruthy();
  click(
    getConnectorAction(
      "button",
      "Manage Acme Search permissions for Support",
      accessDialog,
    ),
  );
  const second = await screen.findByRole("dialog", {
    name: "Acme Search permissions for Support",
  });
  await within(second).findByText("messages:send-as-user");
  click(getConnectorAction("button", "Deny", second));
  firstResponse.resolve();
  await serverCompleted.promise;
  expect(getConnectorAction("button", "Deny", second)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(getConnectorAction("button", "Apply", second));
  await screen.findByText("Permissions updated");
  await waitFor(() => {
    return expect(second).not.toBeInTheDocument();
  });
  click(
    getConnectorAction(
      "button",
      "Manage Acme Search permissions for Support",
      accessDialog,
    ),
  );
  const saved = await screen.findByRole("dialog", {
    name: "Acme Search permissions for Support",
  });
  await within(saved).findByText("messages:send-as-user");
  expect(getConnectorAction("button", "Deny", saved)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(getConnectorAction("button", "Apply", saved)).toBeDisabled();
});
