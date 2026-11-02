import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const now = "2026-09-23T00:00:00.000Z";

test("Remote control lists each connection and filters credentials by type", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: ["Deployment", "Analytics"].map((displayName, index) => {
        return {
          id: `b0000000-0000-4000-8000-00000000000${index + 1}`,
          displayName,
          host: `${displayName.toLowerCase()}.example.com`,
          port: 22,
          username: "deploy",
          credentialId: "d0000000-0000-4000-8000-000000000001",
          credentialName: "Deployment login",
          generation: 1,
          learnedHostKey: null,
          createdAt: now,
          updatedAt: now,
        };
      }),
    });
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, {
      credentials: [
        {
          id: "d0000000-0000-4000-8000-000000000001",
          name: "Deployment login",
          username: "deploy",
          authMethod: "password",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          hosts: ["Deployment", "Analytics"].map((displayName, index) => {
            return {
              id: `b0000000-0000-4000-8000-00000000000${index + 1}`,
              displayName,
            };
          }),
        },
      ],
    });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        {
          id: "e0000000-0000-4000-8000-000000000001",
          displayName: "Design desktop",
          host: "desktop.example.com",
          port: 5900,
          credentialId: "f0000000-0000-4000-8000-000000000001",
          credentialName: "Desktop login",
          security: { type: "x509_vnc", trust: { mode: "system" } },
          generation: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, {
      credentials: [
        {
          id: "f0000000-0000-4000-8000-000000000001",
          name: "Desktop login",
          authMethod: "vnc_password",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          hosts: [
            {
              id: "e0000000-0000-4000-8000-000000000001",
              displayName: "Design desktop",
            },
          ],
        },
      ],
    });
  });

  await setupPage({
    context,
    path: "/connectors?scope=remote-control",
  });
  const connections = await screen.findByRole("list", {
    name: "Remote connections",
  });
  await within(connections).findByRole("listitem", { name: "Deployment" });
  expect(
    within(connections).getByRole("listitem", { name: "Analytics" }),
  ).toBeInTheDocument();
  expect(
    within(connections).getByRole("listitem", { name: "Design desktop" }),
  ).toBeInTheDocument();
  expect(
    screen.getByTestId("connectors-scope-remote-control"),
  ).toHaveTextContent("3");

  click(getConnectorAction("link", "Manage credentials"));
  await screen.findByRole("heading", { name: "Credentials", level: 1 });
  await expect(
    screen.findByRole("heading", { name: "Deployment login" }),
  ).resolves.toBeInTheDocument();
  click(screen.getByRole("radio", { name: "VNC" }));
  await expect(
    screen.findByRole("heading", { name: "Desktop login" }),
  ).resolves.toBeInTheDocument();
  expect(getConnectorAction("button", "Add credential")).toBeInTheDocument();
});
