import {
  vncConnectionsContract,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
  sshHost,
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  base = "/connectors?scope=remote-control",
  warning = "Authentication or server identity verification failed.";
const button = (name: string | RegExp) => {
  return findFastControl("button", name);
};
const press = async (name: string | RegExp) => {
  return click(await button(name));
};
const detail = (id: string) => {
  return base + "&remoteResource=vnc:" + id;
};
function login() {
  return {
    id: remoteId("f", 1),
    name: "Desktop login",
    revision: 3,
    hosts: [],
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
  };
}
async function select(name: string | RegExp, choice: string | RegExp) {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: choice }));
}
async function identity() {
  click(
    await screen.findByText("Server identity and chat permissions", {
      selector: "summary",
    }),
  );
}
function field(name: string | RegExp) {
  return screen.getByLabelText(name, { selector: "input" });
}
function observations(host: VncConnectionResponse) {
  return {
    connectionId: host.id,
    connectionCreatedAt: host.createdAt,
    generation: host.generation,
    observedAt: "2026-10-28T12:34:00.000Z",
    failureReason: "authentication_failed" as const,
  };
}
test.each([
  { id: "vnc-settings-001", outer: "Cloudflare Access" },
  { id: "vnc-settings-002", outer: "Direct" },
])(
  "$id A detached ticket-service route leaves the independent desktop route intact and blocks saving",
  async ({ outer }) => {
    const network = {
      id: remoteId("a", 1),
      name: "Studio network",
      scope: "personal" as const,
      generation: 1,
      revision: 1,
      createdAt: REMOTE_TIMESTAMP,
      updatedAt: REMOTE_TIMESTAMP,
      sshHosts: [],
      vncHosts: [],
    };
    const user = { realm: "STUDIO.EXAMPLE", components: ["operator"] };
    const security = {
      type: "qemu_x509_gssapi" as const,
      trust: { mode: "system" as const },
      serverName: "rfb.studio.example",
      service: { realm: user.realm, components: ["vnc", "rfb.studio.example"] },
      kdc: {
        host: "kdc.studio.example",
        port: 88,
        ticketLifetimeSeconds: 1200,
        renewableLifetimeSeconds: 7200,
        transport: { type: "tailscale" as const, needsRebind: true as const },
      },
    };
    const host = vncHost(1, "Virtual studio", {
      security,
      kerberosAuthentication: "qemu_kerberos_password",
      transport:
        outer === "Direct"
          ? { type: "direct" }
          : {
              type: "cloudflare_access",
              configId: network.id,
              originTls: {
                serverName: "origin.studio.example",
                trust: { mode: "system" },
              },
            },
    });
    mockRemoteInventory(context, {
      vnc: [host],
      vncCredentials: [
        { ...login(), authMethod: "qemu_kerberos_password", initiator: user },
      ],
      cloudflare: [network],
    });
    await setupPage({ context, path: detail(host.id) });
    await screen.findByText(host.displayName);
    await identity();
    await expect(
      screen.findByText("rfb.studio.example", { exact: true }),
    ).resolves.toBeVisible();
    expect(document.body).toHaveTextContent(/Tailscale/);
    expect(document.body).toHaveTextContent(outer);
    expect(document.body.textContent?.includes("origin.studio.example")).toBe(
      outer === "Cloudflare Access",
    );
    await press("Edit connection");
    const route = await screen.findByRole("combobox", {
      name: "Connection method",
    });
    expect(route).toHaveTextContent(outer);
    click(
      await screen.findByText("Connection settings", { selector: "summary" }),
    );
    await expect(
      screen.findByRole("combobox", { name: /KDC.*route|KDC.*method/ }),
    ).resolves.toHaveTextContent("Tailscale");
    await expect(button("Save")).resolves.toBeDisabled();
  },
);
test("vnc-settings-007 Changing the SSH carrier generation clears its desktop failure before the updated observations arrive", async () => {
  const carrier = sshHost(7, "SSH carrier");
  const host = vncHost(7, "Gateway desktop", {
    transport: { type: "ssh", connectionId: carrier.id },
  });
  const inventory = mockRemoteInventory(context, {
    vnc: [host],
    ssh: [carrier],
  });
  let refresh = false;
  const arrived = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  context.mocks.api(
    vncConnectionsContract.observations,
    async ({ respond }) => {
      if (refresh) {
        arrived.resolve();
        await release.promise;
        return respond(200, { observations: [] });
      }
      return respond(200, { observations: [observations(host)] });
    },
  );
  try {
    await setupPage({ context, path: detail(host.id) });
    await screen.findByText(warning);
    refresh = true;
    inventory.ssh = [
      { ...carrier, generation: 2, displayName: "Rotated gateway" },
    ];
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_default" });
    await arrived.promise;
    await screen.findByText(/Rotated gateway/);
    await waitFor(() => {
      return expect(screen.queryByText(warning)).toBeNull();
    });
    expect(screen.getByText(host.displayName)).toBeVisible();
  } finally {
    release.resolve();
  }
});
test("vnc-settings-011 Changing signed-in owners clears the previous desktop warning before the new owner sees their host", async () => {
  const old = vncHost(11, "Former studio"),
    next = vncHost(11, "New studio");
  const inventory = mockRemoteInventory(context, { vnc: [old] });
  const release = context.mocks.deferred<void>(),
    hosts = context.mocks.deferred<void>(),
    start = context.mocks.deferred<void>();
  let switched = false;
  context.mocks.api(
    vncConnectionsContract.observations,
    async ({ respond }) => {
      if (switched) {
        await release.promise;
        return respond(200, { observations: [] });
      }
      return respond(200, { observations: [observations(old)] });
    },
  );
  context.mocks.api(vncConnectionsContract.list, async ({ respond }) => {
    if (switched) {
      if (!start.settled()) {
        start.resolve();
      }
      await hosts.promise;
    }
    return respond(200, { connections: inventory.vnc });
  });
  try {
    await setupPage({ context, path: detail(old.id) });
    await screen.findByText(warning);
    switched = true;
    inventory.vnc = [next];
    context.mocks
      .clerk()
      .user(
        { id: "studio-owner-two", fullName: "New operator" },
        { token: "local-successor" },
      );
    context.mocks.clerk().stateChanged();
    await start.promise;
    await waitFor(() => {
      return expect(screen.queryByText(warning)).toBeNull();
    });
    expect(screen.queryByText(next.displayName)).toBeNull();
    hosts.resolve();
    expect(screen.queryByText(warning)).toBeNull();
    release.resolve();
    await screen.findByText(next.displayName);
    expect(screen.queryByText(warning)).toBeNull();
  } finally {
    if (!hosts.settled()) {
      hosts.resolve();
    }
    if (!release.settled()) {
      release.resolve();
    }
  }
});
test("vnc-settings-019 Replacing a missing SSH route with a public desktop address makes the existing encrypted login savable", async () => {
  const gateway = remoteId("b", 19);
  const host = vncHost(19, "Private studio", {
    host: "127.0.0.1",
    transport: { type: "ssh", connectionId: gateway },
    security: {
      type: "x509_vnc",
      serverName: "studio.internal.example",
      trust: { mode: "system" },
    },
  });
  mockRemoteInventory(context, {
    vnc: [host],
    vncCredentials: [{ ...login(), authMethod: "vnc_password" }],
  });
  const updated = context.mocks.deferred<unknown>();
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    updated.resolve(body);
    return respond(200, {
      ...host,
      host: "studio.example.com",
      transport: { type: "direct" },
      generation: 2,
    });
  });
  await setupPage({ context, path: detail(host.id) });
  await screen.findByText(host.displayName);
  await identity();
  expect(document.body).toHaveTextContent(/SSH/);
  expect(document.body).toHaveTextContent(/127.0.0.1/);
  expect(document.body).toHaveTextContent("studio.internal.example");
  expect(document.body).toHaveTextContent(/unavailable|no longer available/i);
  await press("Edit connection");
  await screen.findByRole("combobox", { name: "Connection method" });
  await expect(button("Save")).resolves.toBeDisabled();
  await select("Connection method", /Direct/);
  await expect(button("Save")).resolves.toBeDisabled();
  await fill(field(/Device address|Public hostname/), "studio.example.com");
  await press("Save");
  await expect(updated.promise).resolves.toMatchObject({
    host: "studio.example.com",
    transport: { type: "direct" },
    security: host.security,
    credential: { id: login().id },
  });
  await screen.findByText(host.displayName);
});
test("vnc-settings-020 Saving an unchanged Apple screen-sharing connection keeps its IPv6 endpoint, carrier and saved login", async () => {
  const carrier = sshHost(20, "Studio carrier"),
    host = vncHost(20, "Mac display", {
      host: "::1",
      port: 5905,
      transport: { type: "ssh", connectionId: carrier.id },
      security: { type: "apple_dh" },
    });
  mockRemoteInventory(context, {
    vnc: [host],
    ssh: [carrier],
    vncCredentials: [
      {
        ...login(),
        authMethod: "apple_dh_username_password",
        username: "designer",
      },
    ],
  });
  const updated = context.mocks.deferred<unknown>();
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    updated.resolve(body);
    return respond(200, host);
  });
  await setupPage({ context, path: detail(host.id) });
  await press("Edit connection");
  await screen.findByLabelText(/^Connection name/);
  expect(field(/^Connection name/)).toHaveValue(host.displayName);
  await expect(
    screen.findByRole("combobox", { name: "Device address" }),
  ).resolves.toHaveTextContent("::1");
  expect(field("Port")).toHaveValue(5905);
  await expect(
    screen.findByRole("combobox", { name: /SSH host/ }),
  ).resolves.toHaveTextContent(carrier.displayName);
  await press("Save");
  await expect(updated.promise).resolves.toMatchObject({
    displayName: host.displayName,
    host: "::1",
    port: 5905,
    transport: host.transport,
    security: host.security,
    credential: { id: login().id },
  });
  await screen.findByText(host.displayName);
});

test("vnc-settings-004 A VNC host keeps its timed warning after a foreign update and clears it after its own update", async () => {
  const desktop = vncHost(44, "Survey console");
  const inventory = mockRemoteInventory(context, { vnc: [desktop] });
  let recovered = false;
  context.mocks.api(vncConnectionsContract.observations, ({ respond }) => {
    return respond(200, {
      observations: recovered ? [] : [observations(desktop)],
    });
  });
  await setupPage({
    context,
    path: detail(desktop.id),
  });
  await screen.findByText(warning);
  expect(
    document.querySelector('time[datetime="2026-10-28T12:34:00.000Z"]'),
  ).toBeVisible();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("vnc:observations-changed"),
    ).toBeTruthy();
  });
  recovered = true;
  context.mocks.ably.trigger("vnc:observations-changed", {
    orgId: "elsewhere",
  });
  // Open another section in the active workspace while the foreign event is delivered.
  await identity();
  expect(screen.getByText(warning)).toBeVisible();
  context.mocks.ably.trigger("vnc:observations-changed", {
    orgId: "org_default",
  });
  await waitFor(() => {
    expect(screen.queryByText(warning)).toBeNull();
  });
  expect(screen.getByText(inventory.vnc[0]!.displayName)).toBeVisible();
});
