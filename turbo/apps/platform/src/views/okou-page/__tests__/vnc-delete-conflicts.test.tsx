import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  vncConnectionsContract,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const host = Object.freeze<
  Extract<VncConnectionResponse, { credentialId: string }>
>({
  id: "b0000000-0000-4000-8000-000000000001",
  displayName: "Design workstation",
  host: "desktop.example.com",
  port: 5900,
  credentialId: "d0000000-0000-4000-8000-000000000001",
  credentialName: "Desktop login",
  security: { type: "x509_vnc", trust: { mode: "system" } },
  generation: 4,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
const credential = Object.freeze<VncCredentialResponse>({
  id: host.credentialId,
  name: host.credentialName,
  authMethod: "vnc_password",
  revision: 3,
  hosts: [{ id: host.id, displayName: host.displayName }],
  createdAt: host.createdAt,
  updatedAt: host.updatedAt,
});

function mockSettings(
  connections: VncConnectionResponse[] = [host],
  credentials: VncCredentialResponse[] = [credential],
) {
  const data = { connections, credentials };
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: data.connections.length });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: data.connections });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: data.credentials });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, { ssh: [], vnc: [] });
    },
  );
  return data;
}

async function page() {
  await setupPage({
    context,
    featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: false },
    path: "/connectors?scope=remote-control&type=vnc",
    auth: {
      user: { id: "vnc-delete-owner", fullName: "VNC Owner" },
      organization: {
        activeOrg: { id: "org_vnc_delete", name: "VNC test organization" },
        memberships: [{ id: "org_vnc_delete" }],
      },
    },
  });
}

test("A stale VNC host generation blocks deletion", async () => {
  const data = mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(
    vncConnectionsContract.delete,
    ({ body, params, respond }) => {
      requests.push({ id: params.connectionId, body });
      if (body.expectedGeneration < 6) {
        data.connections = [
          {
            ...host,
            displayName: `Updated workstation ${body.expectedGeneration + 1}`,
            host: "updated.example.com",
            port: 5902,
            generation: body.expectedGeneration + 1,
          },
        ];
        return respond(409, {
          error: { code: "VNC_GENERATION_CONFLICT", message: "private" },
        });
      }
      data.connections = [];
      return respond(204);
    },
  );
  await page();
  await screen.findByText(host.displayName);
  click(getAction("button", "Delete host"));
  const dialog = await screen.findByRole("dialog", { name: "Delete host" });
  click(getAction("button", "Delete host", dialog));
  await within(dialog).findByRole("alert");
  expect(getAction("button", "Delete host", dialog)).toBeDisabled();
  expect(requests).toStrictEqual([
    { id: host.id, body: { expectedGeneration: 4 } },
  ]);
});

test.each([
  "VNC_CREDENTIAL_REVISION_CONFLICT",
  "VNC_CREDENTIAL_IN_USE",
] as const)(
  "A VNC credential deletion rejected with %s remains blocked",
  async (firstConflict) => {
    const data = mockSettings([], [{ ...credential, hosts: [] }]);
    const requests: unknown[] = [];
    context.mocks.api(
      vncCredentialsContract.delete,
      ({ body, params, respond }) => {
        requests.push({ id: params.credentialId, body });
        if (body.expectedRevision < 5) {
          data.credentials = [
            {
              ...credential,
              name: `Updated login ${body.expectedRevision + 1}`,
              hosts: [],
              revision: body.expectedRevision + 1,
            },
          ];
          return respond(409, {
            error: {
              code:
                body.expectedRevision === 3
                  ? firstConflict
                  : "VNC_CREDENTIAL_REVISION_CONFLICT",
              message: "private",
            },
          });
        }
        data.credentials = [];
        return respond(204);
      },
    );
    await page();
    click(getAction("radio", "Credentials"));
    await screen.findByText(credential.name);
    click(getAction("button", "Delete credential"));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete credential",
    });
    click(getAction("button", "Delete credential", dialog));
    await within(dialog).findByRole("alert");
    expect(getAction("button", "Delete credential", dialog)).toBeDisabled();
    expect(requests).toStrictEqual([
      { id: credential.id, body: { expectedRevision: 3 } },
    ]);
  },
);
