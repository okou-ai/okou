import {
  CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH,
  cloudflareAccessContract,
  type CloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_cloudflare_access";
const timestamp = "2026-09-22T00:00:00.000Z";
const config: CloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Protected applications",
  revision: 1,
  generation: 1,
  sshHosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});

beforeEach(() => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
});

async function page(path = "/connectors/cloudflare-access") {
  await setupPage({
    context,
    path,
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
}

async function tokenFields(dialog: HTMLElement, name = config.name) {
  await fill(within(dialog).getByLabelText("Name"), name);
  await fill(
    within(dialog).getByLabelText("Service Token Client ID"),
    "test-client-id",
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client Secret"),
    "test-client-secret",
  );
}

async function pasteTokenHeaders(
  dialog: HTMLElement,
  label: "Service Token Client ID" | "Service Token Client Secret",
  clipboard: string,
) {
  const user = userEvent.setup();
  await user.click(within(dialog).getByLabelText(label));
  await user.paste(clipboard);
}

test("Cloudflare Access has a standalone connector detail page", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  await page();
  await expect(
    screen.findByRole("heading", { name: "Cloudflare Access" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "Access protected applications with Cloudflare Access Service Tokens.",
    ),
  ).toBeInTheDocument();
  expect(getAction("link", "Connectors")).toHaveAttribute(
    "href",
    "/connectors",
  );
  expect(screen.getByText(config.name)).toBeInTheDocument();
  expect(screen.queryByText("Direct")).toBeNull();
  expect(screen.queryByText("Add access")).toBeNull();
  expect(document.title).toContain("Cloudflare Access");
});

test("The directory add intent is consumed and creates through the canonical API", async () => {
  let configs: CloudflareAccessConfig[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    const created = { ...config, id: body.id, name: body.name };
    configs = [created];
    return respond(201, created);
  });
  await page("/connectors/cloudflare-access?add=1");
  const dialog = await screen.findByRole("dialog", {
    name: "Add Cloudflare Access",
  });
  expect(window.location.search).toBe("");
  await fill(within(dialog).getByLabelText("Name"), config.name);
  await fill(
    within(dialog).getByLabelText("Service Token Client ID"),
    "client-id",
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client Secret"),
    "client-secret",
  );
  click(getAction("button", "Save", dialog));
  await expect(screen.findByText(config.name)).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("The standalone page refreshes from the neutral realtime event", async () => {
  let configs: CloudflareAccessConfig[] = [config];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  await setupPage({
    context,
    path: "/connectors/cloudflare-access",
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
  await screen.findByText(config.name);
  configs = [{ ...config, name: "Updated applications", revision: 2 }];
  context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  await expect(
    screen.findByText("Updated applications"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(config.name)).toBeNull();
});

test("The standalone editor reports Cloudflare Access revision exhaustion without SSH copy", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  context.mocks.api(cloudflareAccessContract.update, ({ respond }) => {
    return respond(409, {
      error: {
        code: "CLOUDFLARE_ACCESS_REVISION_EXHAUSTED",
        message: "not user copy",
      },
    });
  });
  await page();
  click(getAction("button", "Edit Cloudflare Access"));
  const dialog = await screen.findByRole("dialog", {
    name: "Edit Cloudflare Access",
  });
  await fill(within(dialog).getByLabelText("Name"), "Renamed applications");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(
    "This configuration can no longer be updated. Create a new one.",
  );
  expect(dialog).not.toHaveTextContent("SSH configuration");
  expect(document.body.textContent).not.toContain("not user copy");
});

test("The new Access configuration form shows input hints without prefilling tokens", async () => {
  await page();
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog", {
    name: "Add Cloudflare Access",
  });
  const hints = {
    Name: "e.g. Production access",
    "Service Token Client ID": "Paste the Service Token Client ID",
    "Service Token Client Secret": "Paste the Service Token Client Secret",
  };
  for (const [label, hint] of Object.entries(hints)) {
    const field = within(dialog).getByLabelText(label);
    expect(field).toHaveAttribute("placeholder", hint);
    expect(field).toHaveValue("");
    expect(field).toBeInvalid();
  }
  for (const label of [
    "Service Token Client ID",
    "Service Token Client Secret",
  ]) {
    expect(within(dialog).getByLabelText(label)).toHaveAttribute(
      "type",
      "password",
    );
  }
});

test("Raw and invalid token paste stays in the focused Access field", async () => {
  await page();
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  const clientId = within(dialog).getByLabelText("Service Token Client ID");
  const clientSecret = within(dialog).getByLabelText(
    "Service Token Client Secret",
  );
  await pasteTokenHeaders(dialog, "Service Token Client ID", "raw-client-id");
  expect(clientId).toHaveValue("raw-client-id");
  expect(clientSecret).toHaveValue("");

  const incomplete = "CF-Access-Client-Id: incomplete-id";
  await fill(clientId, "");
  await fill(clientSecret, "kept-secret");
  await pasteTokenHeaders(dialog, "Service Token Client ID", incomplete);
  expect(clientId).toHaveValue(incomplete);
  expect(clientSecret).toHaveValue("kept-secret");

  const invalidPairs = [
    "CF-Access-Client-Id: first-id\nCF-Access-Client-Id: duplicate-id",
    "CF-Access-Client-Id: candidate-id\nX-Access-Client-Secret: unknown-secret",
    "CF-Access-Client-Id: candidate-id\nCF-Access-Client-Secret: candidate-secret\nextra",
    "CF-Access-Client-Id: candidate-id\n\nCF-Access-Client-Secret: candidate-secret",
    "CF-Access-Client-Id: candidate-id\nCF-Access-Client-Secret: ",
    "CF-Access-Client-Id: candidate-id\nCF-Access-Client-Secret: non-ascii-密钥",
    `CF-Access-Client-Id: candidate-id\nCF-Access-Client-Secret: ${"x".repeat(CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH + 1)}`,
  ];
  for (const clipboard of invalidPairs) {
    await fill(clientId, "");
    await fill(clientSecret, "kept-secret");
    await pasteTokenHeaders(dialog, "Service Token Client ID", clipboard);
    expect(clientSecret).toHaveValue("kept-secret");
  }
});

test("Standalone Cloudflare Access CRUD uses the canonical API", async () => {
  let configs: CloudflareAccessConfig[] = [];
  const createRequests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    createRequests.push(body);
    const created = { ...config, id: body.id, name: body.name };
    configs = [created];
    return respond(201, created);
  });
  context.mocks.api(cloudflareAccessContract.delete, ({ body, respond }) => {
    expect(body).toStrictEqual({ expectedRevision: 1 });
    configs = [];
    return respond(204);
  });
  await page();
  await screen.findByText("0 Cloudflare Access configured");
  click(getAction("button", "Add Cloudflare Access"));
  let dialog = await screen.findByRole("dialog", {
    name: "Add Cloudflare Access",
  });
  await fill(within(dialog).getByLabelText("Name"), config.name);
  await pasteTokenHeaders(
    dialog,
    "Service Token Client ID",
    "cf-access-client-secret:\tcreated-secret\r\nCF-ACCESS-CLIENT-ID: created-id\r\n",
  );
  expect(within(dialog).getByLabelText("Service Token Client ID")).toHaveValue(
    "created-id",
  );
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("created-secret");
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
  await screen.findByText("1 Cloudflare Access configured");
  expect(createRequests).toStrictEqual([
    {
      id: expect.any(String),
      name: config.name,
      credentials: {
        clientId: "created-id",
        clientSecret: "created-secret",
      },
    },
  ]);
  expect(secret).toHaveValue("");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await screen.findByText(config.name);
  click(getAction("button", "Delete Cloudflare Access"));
  dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  click(getAction("button", "Delete Cloudflare Access", dialog));
  await screen.findByText("0 Cloudflare Access configured");
});

test("Pending and failed Access Save keep secrets for retry; a background refresh cannot reset them", async () => {
  const pending = context.mocks.deferred<void>();
  let failing = true;
  context.mocks.api(cloudflareAccessContract.create, async ({ respond }) => {
    await pending.promise;
    return failing
      ? respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Temporary failure" },
        })
      : respond(201, config);
  });
  await page();
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Saving...", dialog)).toBeDisabled();
  });
  expect(secret).toHaveValue("test-client-secret");
  context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  pending.resolve();
  await within(dialog).findByText(
    /We couldn't confirm whether your changes were saved/u,
  );
  expect(secret).toHaveValue("test-client-secret");
  failing = false;
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(secret).toHaveValue("");
});

test("A committed Access creation completes on same-ID retry without another configuration", async () => {
  const submitted: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    submitted.push(body);
    return submitted.length > 1
      ? respond(204)
      : respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Response unavailable" },
        });
  });
  await page();
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(
    /We couldn't confirm whether your changes were saved/u,
  );
  expect(secret).toHaveValue("test-client-secret");
  expect(secret).toBeDisabled();
  expect(submitted).toHaveLength(1);
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).toHaveProperty("id", expect.any(String));
  expect(submitted[0]).toStrictEqual(submitted[1]);
  expect(secret).toHaveValue("");
});

test("A token replacement conflict preserves input and needs explicit latest-version review", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(cloudflareAccessContract.update, ({ body, respond }) => {
    requests.push(body);
    if (body.expectedRevision === 1) {
      current = { ...config, name: "Renamed elsewhere", revision: 2 };
      return respond(409, {
        error: {
          code: "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
          message: "not user copy",
        },
      });
    }
    return respond(200, { ...current, revision: 3, generation: 2 });
  });
  await page();
  await screen.findByText(config.name);
  click(getAction("button", "Edit Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Replace Service Token" }),
  );
  await pasteTokenHeaders(
    dialog,
    "Service Token Client Secret",
    "CF-Access-Client-Id: replacement-id\nCF-Access-Client-Secret: replacement-secret",
  );
  expect(within(dialog).getByLabelText("Service Token Client ID")).toHaveValue(
    "replacement-id",
  );
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("replacement-secret");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText("Renamed elsewhere");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("replacement-secret");
  click(getAction("button", "Keep my changes with this version", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("replacement-secret");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(requests).toStrictEqual(
    [1, 2].map((expectedRevision) => {
      return {
        expectedRevision,
        credentials: {
          clientId: "replacement-id",
          clientSecret: "replacement-secret",
        },
      };
    }),
  );
  expect(document.body.textContent).not.toContain("not user copy");
});

test("A referenced deletion race explains the new affected host without removing the config", async () => {
  const sshHost = {
    id: "c0000000-0000-4000-8000-000000000001",
    displayName: "Development",
  };
  let current = config;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(cloudflareAccessContract.delete, ({ respond }) => {
    current = { ...config, sshHosts: [sshHost] };
    return respond(409, {
      error: { code: "CLOUDFLARE_ACCESS_IN_USE", message: "not user copy" },
    });
  });
  await page();
  await screen.findByText(config.name);
  click(getAction("button", "Delete Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  click(getAction("button", "Delete Cloudflare Access", dialog));
  await within(dialog).findByText(sshHost.displayName);
  expect(
    getAction("button", "Delete Cloudflare Access", dialog),
  ).toBeDisabled();
  expect(
    getAction("button", "Keep my changes with this version", dialog),
  ).toBeDisabled();
});

test("Changing the owner clears Access secrets and hides the previous owner's configurations", async () => {
  await page();
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  const clerk = context.mocks.clerk();
  clerk.user(
    { id: "other-owner", fullName: "Other Owner" },
    { token: "other-token" },
  );
  clerk.stateChanged();
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(secret).toHaveValue("");
});

test("Renaming changes metadata without requesting a new Service Token", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(cloudflareAccessContract.update, ({ body, respond }) => {
    requests.push(body);
    current = { ...config, name: body.name ?? config.name, revision: 2 };
    return respond(200, current);
  });
  await page();
  await screen.findByText(config.name);
  click(getAction("button", "Edit Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).queryByLabelText("Service Token Client Secret"),
  ).not.toBeInTheDocument();
  await fill(within(dialog).getByLabelText("Name"), "Renamed gateway");
  click(getAction("button", "Save", dialog));
  await screen.findByText("Renamed gateway");
  expect(requests).toStrictEqual([
    { expectedRevision: 1, name: "Renamed gateway" },
  ]);
});

test("Access load failure offers retry while feature unavailability remains distinct", async () => {
  let unavailable = false;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return unavailable
      ? respond(404, {
          error: {
            code: "CLOUDFLARE_ACCESS_UNAVAILABLE",
            message: "not user copy",
          },
        })
      : respond(500, {
          error: { code: "INTERNAL_ERROR", message: "private provider detail" },
        });
  });
  await page();
  await screen.findByText("Could not load Cloudflare Access. Try again.");
  expect(
    queryAction("button", "Add Cloudflare Access"),
  ).not.toBeInTheDocument();
  unavailable = true;
  click(getAction("button", "Retry"));
  await screen.findByText(
    "Cloudflare Access is not available for this account.",
  );
  expect(document.body.textContent).not.toContain("private provider detail");
});
