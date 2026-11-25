import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getButtonByName,
  queryButtonByName,
} from "./artifact-catalog-test-helpers.ts";
import { openSharing } from "./site-access-fixtures.ts";

const context = testContext();
const siteId = "a9100000-0000-4000-8000-000000000054";

function permission(name: string) {
  return screen.getByLabelText(name, { selector: '[role="radio"]' });
}

async function expectPermission(name: string) {
  await waitFor(() => {
    expect(permission(name)).toBeChecked();
    expect(permission(name)).toHaveAttribute("aria-busy", "false");
  });
}

test("owners search accounts in Share, grant access, and remove a named viewer", async () => {
  const shareId = "00000000-0000-4000-8000-000000000009";
  const account = {
    userId: "user_viewer",
    name: "Taylor Viewer",
    email: "taylor@example.com",
  };
  let shared = false;
  context.mocks.api(artifactSharingContract.list, ({ respond }) => {
    return respond(200, {
      shares: shared ? [{ id: shareId, email: account.email }] : [],
    });
  });
  context.mocks.api(artifactSharingContract.search, ({ query, respond }) => {
    expect(query.query.toLowerCase()).toContain("ta");
    return respond(200, { accounts: [account] });
  });
  context.mocks.api(
    artifactSharingContract.share,
    ({ body, params, respond }) => {
      expect(params).toMatchObject({ kind: "site", id: siteId });
      expect(body.email).toBe(account.email);
      shared = true;
      return respond(200, {
        share: { id: shareId, email: account.email },
      });
    },
  );
  context.mocks.api(artifactSharingContract.remove, ({ params, respond }) => {
    expect(params.shareId).toBe(shareId);
    shared = false;
    return respond(200, { removed: shareId });
  });
  await openSharing(context, {
    siteId,
    audience: "private",
    emailSharing: true,
  });
  const menu = await screen.findByRole("dialog", { name: "Share artifact" });
  const input = within(menu).getByRole("combobox", {
    name: "Share with people",
  });
  const inviteButton = getButtonByName("Invite", menu);
  await fill(input, "Ta");
  expect(inviteButton).toBeDisabled();
  click(await screen.findByRole("option", { name: /Taylor Viewer/ }));
  await waitFor(() => {
    return expect(input).toHaveValue(account.email);
  });
  click(inviteButton);
  await waitFor(() => {
    expect(
      queryButtonByName(`Remove access for ${account.email}`, menu),
    ).toBeDefined();
  });
  const remove = getButtonByName(`Remove access for ${account.email}`, menu);
  expect(input).toHaveValue("");
  await expect(
    screen.findByText("Sharing invitation processed"),
  ).resolves.toBeInTheDocument();
  expect(within(menu).queryByText("Can view")).not.toBeInTheDocument();
  click(remove);
  await waitFor(() => {
    return expect(
      within(menu).queryByText("taylor@example.com"),
    ).not.toBeInTheDocument();
  });
});

test("a complete email can be invited without a matching account and private access includes invitees", async () => {
  const email = "new-person@example.com";
  const shareId = "00000000-0000-4000-8000-000000000010";
  let invited = false;
  context.mocks.api(artifactSharingContract.search, ({ respond }) => {
    return respond(200, { accounts: [] });
  });
  context.mocks.api(artifactSharingContract.list, ({ respond }) => {
    return respond(200, {
      shares: invited ? [{ id: shareId, email }] : [],
    });
  });
  context.mocks.api(artifactSharingContract.share, ({ body, respond }) => {
    expect(body.email).toBe(email);
    invited = true;
    return respond(200, {
      share: { id: shareId, email },
    });
  });
  await openSharing(context, {
    siteId,
    audience: "private",
    emailSharing: true,
  });
  const menu = await screen.findByRole("dialog", { name: "Share artifact" });
  expect(permission("Invited people")).toBeChecked();
  const input = within(menu).getByRole("combobox", {
    name: "Share with people",
  });
  const inviteButton = getButtonByName("Invite", menu);
  await fill(input, email);
  await screen.findByText(
    "No workspace matches. Enter a full email to invite.",
  );
  click(inviteButton);
  await expect(
    screen.findByText("Sharing invitation processed"),
  ).resolves.toBeInTheDocument();
  await expect(within(menu).findByText(email)).resolves.toBeInTheDocument();
  expect(within(menu).queryByText("Can view")).not.toBeInTheDocument();
  expect(within(menu).queryByText("Invited")).not.toBeInTheDocument();
  expect(within(menu).getByText(email)).toBeInTheDocument();
});

test("email sharing stays hidden until its feature switch is enabled", async () => {
  await openSharing(context, { siteId, audience: "private" });
  expect(
    screen.queryByRole("combobox", { name: "Share with people" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Only me" })).toBeInTheDocument();
});

test("a limited member search shows a recoverable message while complete email sharing remains available", async () => {
  context.mocks.api(artifactSharingContract.list, ({ respond }) => {
    return respond(200, { shares: [] });
  });
  context.mocks.api(artifactSharingContract.search, ({ query, respond }) => {
    return query.query === "Taylor"
      ? respond(429, {
          error: {
            code: "RATE_LIMITED",
            message: "Too many website sharing requests. Try again later.",
          },
        })
      : respond(200, { accounts: [] });
  });
  await openSharing(context, {
    siteId,
    audience: "private",
    emailSharing: true,
  });
  const menu = await screen.findByRole("dialog", { name: "Share artifact" });
  const input = within(menu).getByRole("combobox", {
    name: "Share with people",
  });
  const inviteButton = getButtonByName("Invite", menu);
  await fill(input, "Taylor");
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Member search is temporarily unavailable. Try again shortly.",
  );
  expect(inviteButton).toBeDisabled();
  await fill(input, "taylor@external.example");
  await screen.findByText(
    "No workspace matches. Enter a full email to invite.",
  );
  expect(within(menu).queryByRole("alert")).not.toBeInTheDocument();
  expect(inviteButton).toBeEnabled();
});

test("a limited invitation keeps its email draft and shows no success confirmation", async () => {
  context.mocks.api(artifactSharingContract.list, ({ respond }) => {
    return respond(200, { shares: [] });
  });
  context.mocks.api(artifactSharingContract.search, ({ respond }) => {
    return respond(200, { accounts: [] });
  });
  context.mocks.api(artifactSharingContract.share, ({ respond }) => {
    return respond(429, {
      error: {
        code: "RATE_LIMITED",
        message: "Too many website sharing requests. Try again later.",
      },
    });
  });
  await openSharing(context, {
    siteId,
    audience: "private",
    emailSharing: true,
  });
  const menu = await screen.findByRole("dialog", { name: "Share artifact" });
  const input = within(menu).getByRole("combobox", {
    name: "Share with people",
  });
  const inviteButton = getButtonByName("Invite", menu);
  await fill(input, "taylor@external.example");
  click(inviteButton);
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Could not update sharing. Try again shortly.",
  );
  expect(input).toHaveValue("taylor@external.example");
  expect(
    screen.queryByText("Sharing invitation processed"),
  ).not.toBeInTheDocument();
  expect(
    queryButtonByName("Remove access for taylor@external.example", menu),
  ).toBeUndefined();
  expect(inviteButton).toBeEnabled();
});

test("audience choices hide people controls and retain drafts and invitations", async () => {
  context.mocks.api(artifactSharingContract.list, ({ respond }) => {
    return respond(200, {
      shares: [
        {
          id: "00000000-0000-4000-8000-000000000011",
          email: "invited@example.com",
        },
      ],
    });
  });
  context.mocks.api(artifactSharingContract.search, ({ respond }) => {
    return respond(200, { accounts: [] });
  });
  await openSharing(context, {
    siteId,
    audience: "private",
    emailSharing: true,
  });
  const menu = await screen.findByRole("dialog", { name: "Share artifact" });
  await expectPermission("Invited people");
  const input = within(menu).getByRole("combobox", {
    name: "Share with people",
  });
  await within(menu).findByRole("list", { name: "People with access" });
  const workspace = permission("Workspace");
  await fill(input, "draft@example.com");

  click(workspace);
  await expectPermission("Workspace");
  expect(
    within(menu).getByText("Default Org members and invited people"),
  ).toBeInTheDocument();
  expect(within(menu).queryByRole("combobox")).not.toBeInTheDocument();
  expect(within(menu).queryByRole("list")).not.toBeInTheDocument();

  click(permission("Anyone"));
  await expectPermission("Anyone");
  expect(within(menu).getByText("Anyone with the link")).toBeInTheDocument();
  expect(within(menu).queryByRole("combobox")).not.toBeInTheDocument();

  click(permission("Invited people"));
  await expectPermission("Invited people");
  expect(
    within(menu).getByRole("combobox", { name: "Share with people" }),
  ).toHaveValue("draft@example.com");
  expect(
    within(menu).getByRole("list", { name: "People with access" }),
  ).toHaveTextContent("invited@example.com");
  expect(getButtonByName("Copy link", menu)).toBeEnabled();
});
