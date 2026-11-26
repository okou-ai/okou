import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  path = "/connectors?scope=remote-control&remoteView=credentials&type=vnc";
async function createLogin(profile?: string) {
  await setupPage({ context, path });
  click(await findFastControl("button", "Add credential"));
  const dialog = await screen.findByRole("dialog", { name: "Add credential" });
  await fill(
    await within(dialog).findByLabelText("Credential name"),
    "Review login",
  );
  if (profile) {
    click(
      await within(dialog).findByRole("combobox", {
        name: "Authentication method",
      }),
    );
    click(await screen.findByRole("option", { name: profile }));
  }
  return dialog;
}
const password = (dialog: HTMLElement) => {
  return within(dialog).getByLabelText("VNC password", { selector: "input" });
};
function creation() {
  const inventory = mockRemoteInventory(context);
  context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
    const item: VncCredentialResponse = {
      id: body.id,
      name: body.name,
      authMethod: "vnc_password",
      revision: 1,
      createdAt: REMOTE_TIMESTAMP,
      updatedAt: REMOTE_TIMESTAMP,
      hosts: [],
    };
    inventory.vncCredentials.push(item);
    return respond(201, item);
  });
  return inventory;
}
test("vnc-settings-052 Unsupported characters remain in the invalid classic VNC password field and leave the new credential unsaved", async () => {
  const store = creation(),
    dialog = await createLogin();
  const secret = password(dialog);
  await fill(secret, "密码");
  click(await findFastControl("button", "Save", dialog));
  expect(secret).toBeInvalid();
  expect(secret).toHaveValue("密码");
  expect(dialog).toBeVisible();
  expect(store.vncCredentials).toStrictEqual([]);
});
test("vnc-settings-044 A 1,026-byte password fails validation in the username-and-password credential editor", async () => {
  const store = creation(),
    dialog = await createLogin("Username and password");
  await fill(
    within(dialog).getByLabelText("Username", { selector: "input" }),
    "vnc-reader",
  );
  const input = within(dialog).getByLabelText("Password", {
    selector: "input",
  });
  await fill(input, "界".repeat(342));
  click(await findFastControl("button", "Save", dialog));
  await screen.findByRole("alert");
  expect(dialog).toBeVisible();
  expect(store.vncCredentials).toStrictEqual([]);
});
test("vnc-settings-053 A known invalid-input response keeps the VNC password editable and its server diagnostics private", async () => {
  mockRemoteInventory(context);
  context.mocks.api(vncCredentialsContract.create, ({ respond }) => {
    return respond(400, {
      error: {
        code: "VNC_INVALID_INPUT",
        message: "Local server-only diagnostic 61",
      },
    });
  });
  const dialog = await createLogin();
  const secret = password(dialog);
  await fill(secret, "fixture7");
  const save = await findFastControl("button", "Save", dialog);
  click(save);
  await screen.findByRole("alert");
  expect(secret).toHaveValue("fixture7");
  expect(secret).toBeEnabled();
  expect(save).toBeEnabled();
  expect(document.body).not.toHaveTextContent(
    "Local server-only diagnostic 61",
  );
});
const common = Object.freeze({
  id: remoteId("f", 90),
  name: "Cluster login",
  revision: 3,
  createdAt: REMOTE_TIMESTAMP,
  updatedAt: REMOTE_TIMESTAMP,
});
const realm = "EXAMPLE.INVALID",
  initiator = Object.freeze({ realm, components: ["Alice"] });
async function edit(
  saved: VncCredentialResponse,
  change: (body: unknown) => void,
  inspectCard?: () => Promise<void>,
) {
  const inventory = mockRemoteInventory(context, { vncCredentials: [saved] });
  context.mocks.api(
    vncCredentialsContract.update,
    ({ params, body, respond }) => {
      if (
        params.credentialId !== saved.id ||
        body.expectedRevision !== saved.revision
      ) {
        return respond(409, {
          error: {
            code: "VNC_CREDENTIAL_CHANGED",
            message: "Stale credential",
          },
        });
      }
      change(body);
      saved = {
        ...saved,
        name: body.name ?? saved.name,
        revision: saved.revision + 1,
      };
      if (
        saved.authMethod === "username_password" &&
        body.authentication?.method === "username_password"
      ) {
        saved = { ...saved, username: body.authentication.username };
      }
      inventory.vncCredentials = [saved];
      return respond(200, saved);
    },
  );
  await setupPage({ context, path });
  await screen.findByText(saved.name);
  await inspectCard?.();
  click(await findFastControl("button", "Edit credential"));
  return screen.findByRole("dialog");
}
async function replaceLogin(dialog: HTMLElement) {
  await within(dialog).findByRole("checkbox", { name: "Change login details" });
  await userEvent
    .setup({ delay: null })
    .click(within(dialog).getByText("Change login details"));
  await waitFor(() => {
    return expect(
      within(dialog).getByRole("checkbox", { name: "Change login details" }),
    ).toBeChecked();
  });
}
async function closeAfterSave(dialog: HTMLElement) {
  click(await findFastControl("button", "Save", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
}
test("vnc-settings-034 Replacing a Kerberos password keeps the initiator fixed and clears the submitted secret", async () => {
  let mutation: unknown;
  const dialog = await edit(
    { ...common, authMethod: "qemu_kerberos_password", initiator, hosts: [] },
    (body) => {
      mutation = body;
    },
  );
  expect(
    dialog.querySelector('input[type="password"]')?.getAttribute("value") ?? "",
  ).toBe("");
  await replaceLogin(dialog);
  const realmField = await within(dialog).findByLabelText("Initiator realm");
  expect(realmField).toHaveAttribute("readonly");
  expect(realmField).toHaveValue(realm);
  const secret = dialog.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  expect(secret).toHaveValue("");
  await fill(secret, "local-kerberos-replacement");
  await closeAfterSave(dialog);
  expect(mutation).toMatchObject({
    expectedRevision: 3,
    authentication: {
      method: "qemu_kerberos_password",
      initiator,
      password: "local-kerberos-replacement",
    },
  });
  expect(secret).toHaveValue("");
  expect(document.body).not.toHaveTextContent("local-kerberos-replacement");
});
test("vnc-settings-048 A credential shared by two devices exposes its edit impact and locks deletion until it is unbound", async () => {
  let mutation: unknown;
  const dialog = await edit(
    {
      ...common,
      authMethod: "vnc_password",
      hosts: [
        { id: remoteId("e", 31), displayName: "Render desk" },
        { id: remoteId("e", 32), displayName: "Backup console" },
      ],
    },
    (body) => {
      mutation = body;
    },
    async () => {
      await expect(
        findFastControl("button", "Delete credential"),
      ).resolves.toBeDisabled();
    },
  );
  await replaceLogin(dialog);
  await within(dialog).findByText(/Backup console/);
  const secret = password(dialog);
  expect(secret).toHaveValue("");
  await fill(secret, "new-pass");
  await closeAfterSave(dialog);
  expect(mutation).toMatchObject({
    expectedRevision: 3,
    authentication: { method: "vnc_password", password: "new-pass" },
  });
  expect(secret).toHaveValue("");
});
test("vnc-settings-043 Renaming a reusable VNC credential preserves authentication and a later login edit clears its exact new password", async () => {
  const writes: unknown[] = [];
  let dialog = await edit(
    {
      ...common,
      authMethod: "username_password",
      username: "old-reader",
      hosts: [{ id: remoteId("e", 40), displayName: "Editing workstation" }],
    },
    (body) => {
      writes.push(body);
    },
  );
  expect(document.body).toHaveTextContent("old-reader");
  expect(dialog).not.toHaveTextContent("local-old-secret");
  const name = within(dialog).getByLabelText("Credential name");
  await fill(name, "Night operator");
  await closeAfterSave(dialog);
  expect(writes).toStrictEqual([
    expect.objectContaining({ name: "Night operator" }),
  ]);
  expect(writes[0]).not.toHaveProperty("authentication");
  await screen.findByText("Night operator");
  click(await findFastControl("button", "Edit credential"));
  dialog = await screen.findByRole("dialog");
  await replaceLogin(dialog);
  const user = await within(dialog).findByLabelText("Username", {
      selector: "input",
    }),
    secret = within(dialog).getByLabelText("Password", { selector: "input" });
  expect(user).toHaveValue("old-reader");
  expect(secret).toHaveValue("");
  await fill(user, "night-reader");
  await fill(secret, "  local pass  ");
  await closeAfterSave(dialog);
  expect(writes.at(-1)).toMatchObject({
    authentication: {
      method: "username_password",
      username: "night-reader",
      password: "  local pass  ",
    },
  });
  expect(secret).toHaveValue("");
  expect(document.body).not.toHaveTextContent("  local pass  ");
  await screen.findByText("night-reader");
});
