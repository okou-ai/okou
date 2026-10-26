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
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

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

test("Deleting a host reviews each newer generation before a separate explicit deletion", async () => {
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
  const review = await within(dialog).findByRole("region", {
    name: "Current saved details",
  });
  await within(review).findByText("Updated workstation 5");
  expect(within(review).getByText("Version 5")).toBeInTheDocument();
  expect(
    within(review).getByText("RFB destination: updated.example.com:5902"),
  ).toBeInTheDocument();
  expect(getAction("button", "Delete host", dialog)).toBeDisabled();
  expect(
    queryAction("button", "Keep my changes with this version", dialog),
  ).toBeNull();
  expect(requests).toStrictEqual([
    { id: host.id, body: { expectedGeneration: 4 } },
  ]);

  getAction("button", "Use this version for deletion", review).focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(getAction("button", "Delete host", dialog)).toBeEnabled();
  });
  expect(requests).toStrictEqual([
    { id: host.id, body: { expectedGeneration: 4 } },
  ]);
  click(getAction("button", "Delete host", dialog));
  const repeated = await within(dialog).findByRole("region", {
    name: "Current saved details",
  });
  await within(repeated).findByText("Updated workstation 6");
  expect(within(repeated).getByText("Version 6")).toBeInTheDocument();
  expect(getAction("button", "Delete host", dialog)).toBeDisabled();
  click(getAction("button", "Use this version for deletion", repeated));
  await waitFor(() => {
    expect(getAction("button", "Delete host", dialog)).toBeEnabled();
  });
  expect(requests).toStrictEqual(
    [4, 5].map((expectedGeneration) => {
      return { id: host.id, body: { expectedGeneration } };
    }),
  );
  click(getAction("button", "Delete host", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await screen.findByText("Add a VNC host to get started.");
  expect(requests).toStrictEqual(
    [4, 5, 6].map((expectedGeneration) => {
      return { id: host.id, body: { expectedGeneration } };
    }),
  );
});

test.each([
  "VNC_CREDENTIAL_REVISION_CONFLICT",
  "VNC_CREDENTIAL_IN_USE",
] as const)(
  "Deleting an unused credential reviews each revision after %s without resubmitting",
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
    const review = await within(dialog).findByRole("region", {
      name: "Current saved details",
    });
    await within(review).findByText("Updated login 4");
    expect(within(review).getByText("Version 4")).toBeInTheDocument();
    expect(getAction("button", "Delete credential", dialog)).toBeDisabled();
    click(getAction("button", "Use this version for deletion", review));
    await waitFor(() => {
      expect(getAction("button", "Delete credential", dialog)).toBeEnabled();
    });
    expect(requests).toStrictEqual([
      { id: credential.id, body: { expectedRevision: 3 } },
    ]);
    click(getAction("button", "Delete credential", dialog));
    const repeated = await within(dialog).findByRole("region", {
      name: "Current saved details",
    });
    await within(repeated).findByText("Updated login 5");
    expect(within(repeated).getByText("Version 5")).toBeInTheDocument();
    expect(getAction("button", "Delete credential", dialog)).toBeDisabled();
    click(getAction("button", "Use this version for deletion", repeated));
    await waitFor(() => {
      expect(getAction("button", "Delete credential", dialog)).toBeEnabled();
    });
    expect(requests).toStrictEqual(
      [3, 4].map((expectedRevision) => {
        return { id: credential.id, body: { expectedRevision } };
      }),
    );
    click(getAction("button", "Delete credential", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await screen.findByText("No saved VNC credentials.");
    expect(requests).toStrictEqual(
      [3, 4, 5].map((expectedRevision) => {
        return { id: credential.id, body: { expectedRevision } };
      }),
    );
  },
);

test.each([
  "VNC_CREDENTIAL_REVISION_CONFLICT",
  "VNC_CREDENTIAL_IN_USE",
] as const)(
  "A newly bound credential blocks reviewed deletion after %s until its host references are released",
  async (code) => {
    const data = mockSettings([], [{ ...credential, hosts: [] }]);
    const requests: unknown[] = [];
    context.mocks.api(vncCredentialsContract.delete, ({ body, respond }) => {
      requests.push(body);
      if (body.expectedRevision === 3) {
        data.connections = [host];
        data.credentials = [{ ...credential, revision: 4 }];
        return respond(409, { error: { code, message: "private" } });
      }
      data.credentials = [];
      return respond(204);
    });
    await page();
    click(getAction("radio", "Credentials"));
    await screen.findByText(credential.name);
    click(getAction("button", "Delete credential"));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete credential",
    });
    click(getAction("button", "Delete credential", dialog));
    const review = await within(dialog).findByRole("region", {
      name: "Current saved details",
    });
    await within(review).findByText(host.displayName);
    expect(within(review).getByText("Version 4")).toBeInTheDocument();
    expect(
      within(review).getByText(
        "Delete or reassign the hosts using this credential before deleting it.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Not used by any saved host."),
    ).toBeNull();
    expect(
      getAction("button", "Use this version for deletion", review),
    ).toBeDisabled();
    expect(getAction("button", "Delete credential", dialog)).toBeDisabled();
    expect(requests).toStrictEqual([{ expectedRevision: 3 }]);

    data.connections = [];
    data.credentials = [
      { ...credential, name: "Released login", revision: 5, hosts: [] },
    ];
    click(getAction("button", "Try again", review));
    await within(review).findByText("Released login");
    expect(within(review).getByText("Version 5")).toBeInTheDocument();
    expect(
      within(review).getByText("Not used by any saved host."),
    ).toBeInTheDocument();
    expect(getAction("button", "Delete credential", dialog)).toBeDisabled();
    click(getAction("button", "Use this version for deletion", review));
    await waitFor(() => {
      expect(getAction("button", "Delete credential", dialog)).toBeEnabled();
    });
    expect(requests).toStrictEqual([{ expectedRevision: 3 }]);
    click(getAction("button", "Delete credential", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await screen.findByText("No saved VNC credentials.");
    expect(requests).toStrictEqual([
      { expectedRevision: 3 },
      { expectedRevision: 5 },
    ]);
  },
);

test.each(["host", "credential"] as const)(
  "A missing %s cannot authorize a reviewed deletion",
  async (resource) => {
    const data = mockSettings([], [{ ...credential, hosts: [] }]);
    data.connections = resource === "host" ? [host] : [];
    const requests: unknown[] = [];
    context.mocks.api(vncConnectionsContract.delete, ({ body, respond }) => {
      requests.push(body);
      data.connections = [];
      return respond(409, {
        error: { code: "VNC_GENERATION_CONFLICT", message: "private" },
      });
    });
    context.mocks.api(vncCredentialsContract.delete, ({ body, respond }) => {
      requests.push(body);
      data.credentials = [];
      return respond(409, {
        error: { code: "VNC_CREDENTIAL_REVISION_CONFLICT", message: "private" },
      });
    });
    await page();
    if (resource === "credential") {
      click(getAction("radio", "Credentials"));
    }
    await screen.findByText(
      resource === "host" ? host.displayName : credential.name,
    );
    const title = resource === "host" ? "Delete host" : "Delete credential";
    click(getAction("button", title));
    const dialog = await screen.findByRole("dialog", { name: title });
    click(getAction("button", title, dialog));
    const review = await within(dialog).findByRole("region", {
      name: "Current saved details",
    });
    await within(review).findByText(
      "This resource is no longer available. Close this dialog and refresh the configuration before trying again.",
    );
    expect(
      queryAction("button", "Use this version for deletion", review),
    ).toBeNull();
    expect(getAction("button", title, dialog)).toBeDisabled();
    expect(requests).toStrictEqual([
      resource === "host" ? { expectedGeneration: 4 } : { expectedRevision: 3 },
    ]);
  },
);

test("A failed deletion-conflict reload requires successful metadata review before retrying deletion", async () => {
  const data = mockSettings();
  let reloadFailed = false;
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return reloadFailed
      ? respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "unavailable" },
        })
      : respond(200, { connections: data.connections });
  });
  context.mocks.api(vncConnectionsContract.delete, ({ body, respond }) => {
    requests.push(body);
    if (body.expectedGeneration === 4) {
      reloadFailed = true;
      data.connections = [
        { ...host, displayName: "Updated workstation", generation: 5 },
      ];
      return respond(409, {
        error: { code: "VNC_GENERATION_CONFLICT", message: "private" },
      });
    }
    data.connections = [];
    return respond(204);
  });
  await page();
  await screen.findByText(host.displayName);
  click(getAction("button", "Delete host"));
  const dialog = await screen.findByRole("dialog", { name: "Delete host" });
  click(getAction("button", "Delete host", dialog));
  const review = await within(dialog).findByRole("region", {
    name: "Current saved details",
  });
  await within(review).findByText("Could not load VNC configuration.");
  expect(getAction("button", "Delete host", dialog)).toBeDisabled();
  expect(
    queryAction("button", "Use this version for deletion", review),
  ).toBeNull();
  reloadFailed = false;
  click(getAction("button", "Try again", review));
  await within(review).findByText("Updated workstation");
  expect(within(review).getByText("Version 5")).toBeInTheDocument();
  click(getAction("button", "Use this version for deletion", review));
  await waitFor(() => {
    expect(getAction("button", "Delete host", dialog)).toBeEnabled();
  });
  expect(requests).toStrictEqual([{ expectedGeneration: 4 }]);
  click(getAction("button", "Delete host", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await screen.findByText("Add a VNC host to get started.");
  expect(requests).toStrictEqual([
    { expectedGeneration: 4 },
    { expectedGeneration: 5 },
  ]);
});
