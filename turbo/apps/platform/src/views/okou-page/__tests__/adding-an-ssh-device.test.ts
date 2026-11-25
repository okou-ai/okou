import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
  sshHost,
  type RemoteInventory,
} from "./connectors-remote-control-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const open = () => {
  return setupPage({
    context,
    path: "/connectors?scope=remote-control&setup=ssh&step=login",
  });
};
const field = (label: RegExp) => {
  return screen.findByLabelText(label, { selector: "input" });
};
async function credentials() {
  const user = await field(/^SSH username$/i),
    pass = await field(/^Password/i);
  await fill(user, "local-reader");
  await fill(pass, "local-pass-821");
  const address = await field(/^Device address$/i);
  await fill(address, "studio.example.test");
  click(await screen.findByText("Connection name (optional)"));
  const name = await field(/^Connection name$/);
  expect(name).not.toBeRequired();
  await fill(name, "Editing station");
  return { user, pass, address, name };
}
function networks(): Partial<RemoteInventory> {
  const listed = (n: number, name: string) => {
    return {
      id: remoteId("c", n),
      name,
      scope: "personal" as const,
      revision: 2,
      generation: 3,
      createdAt: REMOTE_TIMESTAMP,
      updatedAt: REMOTE_TIMESTAMP,
      sshHosts: [],
      vncHosts: [],
    };
  };
  return {
    tailscale: [
      { ...listed(91, "Office network"), tags: ["tag:studio"] },
      { ...listed(92, "Home network"), tags: ["tag:studio"] },
    ],
    cloudflare: [listed(93, "Tools gateway")],
  };
}
test("remote-control-guided-setup-043 Direct is selected until the user chooses the Home Tailscale network from all saved providers", async () => {
  mockRemoteInventory(context, networks());
  await open();
  const method = await screen.findByRole("combobox", {
    name: "Connection method",
  });
  expect(method).toHaveTextContent("Direct connection");
  click(method);
  await waitFor(() => {
    return expect(
      screen.getAllByRole("option").some((el) => {
        return el.textContent?.includes("Office network");
      }),
    ).toBeTruthy();
  });
  await screen.findByRole("option", {
    name: /Tools gateway · Cloudflare Access/,
  });
  click(
    await screen.findByRole("option", { name: /Home network · Tailscale$/ }),
  );
  await waitFor(() => {
    return expect(method).toHaveTextContent("Home network");
  });
  expect(screen.queryByText(/No networks added yet/)).toBeNull();
});
test("remote-control-guided-setup-042 A failed network-list read preserves usable direct SSH without an empty private-network choice", async () => {
  mockRemoteInventory(context);
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "SERVER_ERROR", message: "Inventory offline" },
    });
  });
  await open();
  await screen.findByText(
    "Unable to load this step. Your entries are saved in the form.",
  );
  const method = await screen.findByRole("combobox", {
    name: "Connection method",
  });
  expect(method).toHaveTextContent("Direct connection");
  click(method);
  await expect(
    screen.findByRole("option", { name: "Direct connection" }),
  ).resolves.toBeVisible();
  expect(
    screen.queryByRole("option", { name: /Private networks/i }),
  ).toBeNull();
  expect(screen.queryByText(/No networks added yet/)).toBeNull();
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await expect(field(/^Device address$/)).resolves.toBeEnabled();
});
test("remote-control-guided-setup-041 A held empty inventory adds private-network guidance only inside the open selector", async () => {
  mockRemoteInventory(context);
  const inventory = context.mocks.deferred<void>(),
    started = context.mocks.deferred<void>();
  context.mocks.api(tailscaleContract.list, async ({ respond }) => {
    if (!started.settled()) {
      started.resolve();
    }
    await inventory.promise;
    return respond(200, { configs: [] });
  });
  try {
    await open();
    const method = await screen.findByRole("combobox", {
      name: "Connection method",
    });
    click(method);
    await started.promise;
    await expect(
      screen.findByRole("option", { name: "Direct connection" }),
    ).resolves.toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Private networks/i }),
    ).toBeNull();
    inventory.resolve();
    const empty = await screen.findByRole("option", {
      name: /Private networks/i,
    });
    expect(empty).toHaveAttribute("aria-disabled", "true");
    expect(empty).toHaveTextContent(/network/i);
    click(screen.getByRole("option", { name: "Direct connection" }));
    await waitFor(() => {
      return expect(empty).not.toBeInTheDocument();
    });
    expect(method).toHaveTextContent("Direct connection");
    await expect(field(/^Device address$/)).resolves.toBeEnabled();
  } finally {
    if (!inventory.settled()) {
      inventory.resolve();
    }
  }
});
test("remote-control-guided-setup-051 Keyboard switching SSH login methods retains the username and swaps the required secret", async () => {
  mockRemoteInventory(context);
  await open();
  const user = await field(/^SSH username$/);
  await fill(user, "design-user");
  const password = await field(/^Password/i);
  expect(password).toBeRequired();
  const passwordMode = await screen.findByText("Account password", {
    exact: true,
  });
  passwordMode.focus();
  const keys = userEvent.setup({ delay: null });
  await keys.keyboard("{ArrowRight}");
  const key = await screen.findByLabelText("Private key", {
    selector: "textarea",
  });
  expect(key).toBeRequired();
  await expect(screen.findByText("Choose file")).resolves.toBeVisible();
  await expect(field(/passphrase/i)).resolves.not.toBeRequired();
  expect(password).not.toBeInTheDocument();
  expect(user).toHaveValue("design-user");
  await keys.keyboard("{ArrowLeft}");
  await expect(field(/^Password/i)).resolves.toBeRequired();
  expect(key).not.toBeInTheDocument();
  expect(user).toHaveValue("design-user");
});
test("remote-control-guided-setup-052 SSH key help names local and cloud key locations without filling the private key", async () => {
  mockRemoteInventory(context);
  await open();
  click(await screen.findByText("SSH key", { exact: true }));
  const key = await screen.findByLabelText("Private key", {
    selector: "textarea",
  });
  click(
    await findFastControl("button", /Where can I find the SSH private key/),
  );
  const guide = await screen.findByRole("dialog");
  expect(within(guide).getAllByRole("listitem")).toHaveLength(3);
  for (const hint of ["%USERPROFILE%", ".pem", "target account"]) {
    expect(guide).toHaveTextContent(hint);
  }
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(guide).not.toBeInTheDocument();
  });
  expect(key).toHaveValue("");
});
async function rejectDraft(status: 400 | 500, code: string) {
  mockRemoteInventory(context);
  context.mocks.api(sshConnectionsContract.create, ({ respond }) => {
    return respond(status, { error: { code, message: "Synthetic rejection" } });
  });
  await open();
  const { name } = await credentials();
  const add = await findFastControl("button", "Add connection");
  click(add);
  const message = await screen.findByRole("alert");
  return { name, add, message };
}
test("remote-control-guided-setup-054 An invalid SSH host keeps the name editable for a retry", async () => {
  const { name, add, message } = await rejectDraft(400, "SSH_INVALID_HOST");
  expect(name).toHaveValue("Editing station");
  expect(message).toHaveTextContent(/hostname|address/i);
  expect(add).toBeEnabled();
  expect(screen.queryByText("Connection added")).toBeNull();
});
test("remote-control-guided-setup-068 An unknown SSH save outcome locks the name and both login methods", async () => {
  const { name, message } = await rejectDraft(500, "SERVER_ERROR");
  expect(name).toHaveValue("Editing station");
  expect(message).toHaveTextContent("Save failed.");
  expect(name).toBeDisabled();
  for (const option of ["SSH key", "Account password"]) {
    await expect(
      screen.findByText(option, { exact: true }),
    ).resolves.toHaveAttribute("aria-disabled", "true");
  }
});
test("remote-control-guided-setup-039 A direct SSH device keeps its name, password and username through help and saves on the default port", async () => {
  const inventory = mockRemoteInventory(context);
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    const record = sshHost(91, body.displayName, {
      id: body.id,
      host: body.host,
      port: body.port,
    });
    inventory.ssh.push(record);
    return respond(201, record);
  });
  await open();
  const { user, pass, address, name } = await credentials();
  expect(pass).toHaveAttribute("type", "password");
  click(await findFastControl("button", "Show entered value"));
  expect(pass).toHaveAttribute("type", "text");
  click(await findFastControl("button", "Hide entered value"));
  expect(pass).toHaveAttribute("type", "password");
  click(await findFastControl("button", /username/i));
  const help = await screen.findByRole("dialog");
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(help).not.toBeInTheDocument();
  });
  expect(user).toHaveValue("local-reader");
  expect(pass).toHaveValue("local-pass-821");
  expect(address).toHaveValue("studio.example.test");
  expect(name).toHaveValue("Editing station");
  click(await findFastControl("button", "Add connection"));
  await screen.findByText("Connection added");
  expect(queryFastControl("link", "Open chat")).toBeNull();
  click(await findFastControl("link", "View connection"));
  await screen.findByRole("heading", { name: "Editing station" });
  await screen.findByText(/studio\.example\.test/);
  await screen.findByText(/\b22\b/);
});
