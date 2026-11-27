import {
  findFastControl,
  queryFastControl,
} from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import {
  getButtonByName,
  artifact,
  findArtifactAction,
  queryButtonByName,
} from "./artifact-catalog-test-helpers.ts";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { hostedSiteArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { openSharing } from "./site-access-fixtures.ts";

const context = testContext();

const siteId = "947bde62-1f8c-4879-a5db-ab15dbe67f8d";
const link = (slug: string) => {
  return `https://${slug}.sites.vm7.io`;
};
async function openSite(
  options: {
    gate?: Promise<void>;
    bannerGate?: Promise<void>;
    failRead?: boolean;
    rejectSave?: 409 | 500;
    failCheckName?: string;
  } = {},
) {
  const published = artifact({ kind: "hosted-site", title: "Planning board" });
  const last = options.gate ? "previous-board" : "planning-board";
  const current = "planning-board";
  const data = hostedSiteArtifactDetail(published, {
    siteId,
    slug: last,
    url: link(last),
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [published], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, data);
  });
  context.mocks.api(hostContract.siteUrl, async ({ respond }) => {
    await options.gate;
    if (options.failRead) {
      throw new Error("Unavailable site origin");
    }
    return respond(200, {
      siteId,
      publicSlug: current,
      url: link(current),
      isActive: true,
    });
  });
  context.mocks.api(artifactAccessContract.getVisibility, ({ respond }) => {
    return respond(200, {
      artifactId: siteId,
      kind: "hosted-site",
      visibility: "public",
      ownerUrl: link(current),
      shareUrl: link(current),
      shortUrl: null,
      organization: { id: "org_default", name: "Default Org" },
    });
  });
  context.mocks.api(hostContract.siteBanner, async ({ respond }) => {
    await options.bannerGate;
    return respond(200, { siteId, showBanner: false, revision: null });
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ query, respond }) => {
    return query.publicSlug === options.failCheckName
      ? respond(400, {
          error: { code: "CHECK_FAILED", message: "Check unavailable" },
        })
      : respond(200, { available: true });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
    if (options.rejectSave === 409) {
      return respond(409, { error: { code: "CONFLICT", message: "Conflict" } });
    }
    if (options.rejectSave) {
      throw new Error("Publication service unavailable");
    }
    return respond(200, {
      siteId,
      publicSlug: body.publicSlug,
      url: link(body.publicSlug),
      isActive: true,
    });
  });
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.HostedSiteShareRows]: true },
  });
  click(await findArtifactAction("Planning board"));
  if (!options.gate) {
    click(await findFastControl("button", "Share artifact"));
  }
}
const shareDialog = () => {
  return screen.getByRole("dialog", { name: "Share artifact" });
};
const menu = () => {
  return within(screen.getByRole("dialog", { name: "Share artifact" }));
};
const button = (name: string) => {
  return getButtonByName(name, shareDialog());
};
function currentAddressRow() {
  return waitFor(() => {
    const row = getButtonByName("Customize URL", shareDialog());
    expect(row).toHaveTextContent("planning-board.sites.vm7.io");
    return row;
  });
}
async function customize() {
  click(await currentAddressRow());
  return screen.findByRole("textbox");
}
async function verifyCopy(writes: readonly string[], url: string) {
  const copy = await waitFor(() => {
    const control = button("Copy link");
    expect(control).toBeEnabled();
    return control;
  });
  click(copy);
  await waitFor(() => {
    return expect(writes).toStrictEqual([url]);
  });
}
test("A site with a stale preview address only offers sharing once the current address arrives", async () => {
  const gate = context.mocks.deferred<void>();
  const clip = context.mocks.browser.clipboardWriteText();
  await openSite({ gate: gate.promise });
  await screen.findByTestId("artifact-sidebar");
  expect(screen.getByLabelText("Share artifact")).not.toBeVisible();
  await expect(
    findFastControl("button", "Close artifact"),
  ).resolves.toBeEnabled();
  gate.resolve();
  click(await findFastControl("button", "Share artifact"));
  await currentAddressRow();
  await verifyCopy(clip.writes, link("planning-board"));
});
test("hosted-site-sharing-010 The share row and clipboard both expose the current site URL before editing", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  await openSite();
  const row = await currentAddressRow();
  await waitFor(() => {
    return expect(row).toHaveTextContent(/planning-board/);
  });
  await verifyCopy(clip.writes, link("planning-board"));
  click(row);
  await expect(screen.findByRole("textbox")).resolves.toHaveValue(
    "planning-board",
  );
});
test("hosted-site-sharing-011 Unavailable site settings disable copying and hide address customization", async () => {
  await openSite({ failRead: true });
  await screen.findByText("Could not load website settings");
  expect(button("Copy link")).toBeDisabled();
  expect(queryFastControl("button", /Customize URL/)).toBeNull();
});
test("hosted-site-sharing-008 An address check error keeps Save disabled until a revised address is available", async () => {
  await openSite({ failCheckName: "first-attempt" });
  const input = await customize();
  await fill(input, "first-attempt");
  await screen.findByText("Could not check this address.");
  expect(button("Save")).toBeDisabled();
  await fill(input, "second-attempt");
  await screen.findByText("Available");
  expect(button("Save")).toBeEnabled();
});
test("hosted-site-sharing-007 Cancelling a conflicting address change keeps the original copy destination", async () => {
  await openSite({ rejectSave: 409 });
  const input = await customize();
  await fill(input, "conflicting-title");
  const clip = context.mocks.browser.clipboardWriteText();
  await screen.findByText("Available");
  click(button("Save"));
  await screen.findByText(
    "Could not save. The address may be taken or changed.",
  );
  expect(input).toHaveValue("conflicting-title");
  click(button("Cancel"));
  await currentAddressRow();
  await verifyCopy(clip.writes, link("planning-board"));
});
test("hosted-site-sharing-002 Saving the validated address updates the preview without copying until requested", async () => {
  await openSite();
  const input = await customize();
  await fill(input, "launch-report");
  const clip = context.mocks.browser.clipboardWriteText();
  await screen.findByText("Available");
  expect(screen.getByText(/The old URL will stop working/)).toBeVisible();
  click(button("Save"));
  await screen.findByText("Website URL updated");
  await waitFor(() => {
    return expect(document.querySelector("iframe")?.src).toContain(
      "launch-report.sites.vm7.io",
    );
  });
  expect(clip.writes).toStrictEqual([]);
  await verifyCopy(clip.writes, link("launch-report"));
});

test("hosted-site-sharing-009 A failed save keeps the validated name editable and the original preview visible", async () => {
  await openSite({ rejectSave: 500 });
  const input = await customize();
  await fill(input, "summer-report");
  await screen.findByText("Available");
  click(button("Save"));
  await screen.findByText(
    "Could not save. The address may be taken or changed.",
  );
  expect(input).toHaveValue("summer-report");
  expect(button("Save")).toBeEnabled();
  expect(document.querySelector("iframe")?.src).toContain(
    "planning-board.sites.vm7.io",
  );
});
test("hosted-site-sharing-015 The dialog allows copying while banner preferences are still loading", async () => {
  const gate = context.mocks.deferred<void>();
  const clip = context.mocks.browser.clipboardWriteText();
  await openSite({ bannerGate: gate.promise });
  await currentAddressRow();
  expect(getButtonByName("Close artifact")).toBeVisible();
  expect(getButtonByName("Share artifact")).toBeVisible();
  expect(menu().queryByRole("status", { name: /loading/i })).toBeNull();
  await verifyCopy(clip.writes, link("planning-board"));
  gate.resolve();
  const banner = await menu().findByRole("switch", {
    name: "Show Okou banner",
  });
  expect(banner).not.toBeChecked();
});

const invitedSiteId = "a9100000-0000-4000-8000-000000000054";

function permission(name: string) {
  return screen.getByLabelText(name, { selector: '[role="radio"]' });
}

async function expectPermission(name: string) {
  await waitFor(() => {
    expect(permission(name)).toBeChecked();
    expect(screen.getByRole("radiogroup")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });
}

test("owners search accounts in Share, grant access, and remove a named viewer", async () => {
  const account = {
    userId: "user_viewer",
    name: "Taylor Viewer",
    email: "taylor@example.com",
  };
  let shared = false;
  context.mocks.api(artifactAccessContract.listShares, ({ respond }) => {
    return respond(200, {
      shares: shared
        ? [
            {
              userId: account.userId,
              email: account.email,
              name: account.name,
            },
          ]
        : [],
    });
  });
  context.mocks.api(
    artifactAccessContract.searchShareAccounts,
    ({ query, respond }) => {
      expect(query.query.toLowerCase()).toContain("ta");
      return respond(200, { accounts: [account] });
    },
  );
  context.mocks.api(
    artifactAccessContract.addShare,
    ({ body, params, respond }) => {
      expect(params).toMatchObject({ artifactId: invitedSiteId });
      expect(body).toStrictEqual({ userId: account.userId });
      shared = true;
      return respond(200, {
        share: {
          userId: account.userId,
          email: account.email,
          name: account.name,
        },
      });
    },
  );
  context.mocks.api(
    artifactAccessContract.removeShare,
    ({ params, respond }) => {
      expect(params.userId).toBe(account.userId);
      shared = false;
      return respond(200, { removed: account.userId });
    },
  );
  await openSharing(context, {
    siteId: invitedSiteId,
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

test("a complete email can be shared by email fallback and private access includes shared members", async () => {
  const email = "member-person@example.com";
  const resolvedUserId = "user_member_person";
  let invited = false;
  context.mocks.api(
    artifactAccessContract.searchShareAccounts,
    ({ respond }) => {
      return respond(200, { accounts: [] });
    },
  );
  context.mocks.api(artifactAccessContract.listShares, ({ respond }) => {
    return respond(200, {
      shares: invited ? [{ userId: resolvedUserId, email }] : [],
    });
  });
  context.mocks.api(artifactAccessContract.addShare, ({ body, respond }) => {
    expect(body).toStrictEqual({ email });
    invited = true;
    return respond(200, {
      share: { userId: resolvedUserId, email },
    });
  });
  await openSharing(context, {
    siteId: invitedSiteId,
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
  await openSharing(context, { siteId: invitedSiteId, audience: "private" });
  expect(
    screen.queryByRole("combobox", { name: "Share with people" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Only me" })).toBeInTheDocument();
});

test("a limited member search shows a recoverable message while complete email sharing remains available", async () => {
  context.mocks.api(artifactAccessContract.listShares, ({ respond }) => {
    return respond(200, { shares: [] });
  });
  context.mocks.api(
    artifactAccessContract.searchShareAccounts,
    ({ query, respond }) => {
      return query.query === "Taylor"
        ? respond(429, {
            error: {
              code: "RATE_LIMITED",
              message: "Too many website sharing requests. Try again later.",
            },
          })
        : respond(200, { accounts: [] });
    },
  );
  await openSharing(context, {
    siteId: invitedSiteId,
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
  context.mocks.api(artifactAccessContract.listShares, ({ respond }) => {
    return respond(200, { shares: [] });
  });
  context.mocks.api(
    artifactAccessContract.searchShareAccounts,
    ({ respond }) => {
      return respond(200, { accounts: [] });
    },
  );
  context.mocks.api(artifactAccessContract.addShare, ({ respond }) => {
    return respond(429, {
      error: {
        code: "RATE_LIMITED",
        message: "Too many website sharing requests. Try again later.",
      },
    });
  });
  await openSharing(context, {
    siteId: invitedSiteId,
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

test("people controls stay available in every audience and keep drafts and invitations", async () => {
  const sharedUserId = "user_invited";
  let shares = [
    {
      userId: sharedUserId,
      email: "invited@example.com",
    },
  ];
  context.mocks.api(artifactAccessContract.listShares, ({ respond }) => {
    return respond(200, { shares });
  });
  context.mocks.api(
    artifactAccessContract.searchShareAccounts,
    ({ respond }) => {
      return respond(200, { accounts: [] });
    },
  );
  context.mocks.api(
    artifactAccessContract.removeShare,
    ({ params, respond }) => {
      expect(params.userId).toBe(sharedUserId);
      shares = [];
      return respond(200, { removed: sharedUserId });
    },
  );
  await openSharing(context, {
    siteId: invitedSiteId,
    audience: "private",
    emailSharing: true,
  });
  const menu = await screen.findByRole("dialog", { name: "Share artifact" });
  await expectPermission("Invited people");
  const input = within(menu).getByRole("combobox", {
    name: "Share with people",
  });
  await within(menu).findByRole("list", { name: "People with access" });
  await fill(input, "draft@example.com");

  // Invitations keep granting access in every audience, so the people
  // controls stay in the accessibility tree instead of collapsing.
  click(permission("Workspace"));
  await expectPermission("Workspace");
  expect(
    within(menu).getByText("Default Org members and invited people"),
  ).toBeInTheDocument();
  expect(
    within(menu).getByRole("combobox", { name: "Share with people" }),
  ).toHaveValue("draft@example.com");
  expect(
    within(menu).getByRole("list", { name: "People with access" }),
  ).toHaveTextContent("invited@example.com");

  click(permission("Anyone"));
  await expectPermission("Anyone");
  expect(within(menu).getByText("Anyone with the link")).toBeInTheDocument();
  expect(
    within(menu).getByRole("list", { name: "People with access" }),
  ).toHaveTextContent("invited@example.com");

  click(getButtonByName("Remove access for invited@example.com", menu));
  await waitFor(() => {
    return expect(
      within(menu).getByRole("list", { name: "People with access" }),
    ).not.toHaveTextContent("invited@example.com");
  });
  expect(permission("Anyone")).toBeChecked();
  expect(getButtonByName("Copy link", menu)).toBeEnabled();
});
