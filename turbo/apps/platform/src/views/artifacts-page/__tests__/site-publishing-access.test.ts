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
import { expect, test, vi } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { hostedSiteArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import { openSharing, stable, temporary } from "./site-access-fixtures.ts";
import { posthog } from "posthog-js/dist/module.slim";
import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";

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
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "public", revision: null });
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

const publicChoice = "Anyone with the link";
const privateChoice = "Only me";
const orgChoice = "Anyone at Default Org";
async function preview(url: string) {
  await waitFor(() => {
    return expect(document.querySelector("iframe")?.src).toBe(url);
  });
}
test("hosted-site-sharing-026 The sidebar retains the private owner preview across audience changes and copies the permanent address", async () => {
  const { button, menu, clipboard } = await openSharing(context, {
    audience: "private",
  });
  await preview(temporary);
  for (const name of [orgChoice, publicChoice, privateChoice]) {
    const radio = await menu.findByRole("radio", { name });
    click(radio);
    await waitFor(() => {
      return expect(radio).toBeChecked();
    });
    await preview(temporary);
  }
  const copy = await button("Copy link");
  expect(copy).toBeEnabled();
  click(copy);
  await button("Copied");
  expect(clipboard.writes).toStrictEqual([stable]);
});
test.each(["private", "public"] as const)(
  "hosted-site-sharing-027 An owner who opens a %s site can still share and copy after changing its audience",
  async (initial) => {
    const { button, menu, clipboard } = await openSharing(context, {
      audience: initial,
      preserveTemporaryPreview: true,
    });
    await preview(temporary);
    const previous = await menu.findByRole("radio", {
      name: initial === "public" ? publicChoice : privateChoice,
    });
    expect(previous).toBeChecked();
    const changed = await menu.findByRole("radio", {
      name: initial === "public" ? privateChoice : publicChoice,
    });
    click(changed);
    await waitFor(() => {
      return expect(changed).toBeChecked();
    });
    expect(queryFastControl("button", "Share artifact")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await preview(temporary);
    const copy = await button("Copy link");
    expect(copy).toBeEnabled();
    click(copy);
    await button("Copied");
    expect(clipboard.writes).toStrictEqual([stable]);
  },
);

test("Sharing stays unavailable until the private audience is known", async () => {
  const release = context.mocks.deferred<void>();
  const opening = openSharing(context, {
    audience: "private",
    visibilityRead: release.promise,
  });
  await screen.findByTestId("artifact-sidebar");
  expect(screen.queryByRole("dialog", { name: "Share artifact" })).toBeNull();
  expect(queryFastControl("button", "Share artifact")).toBeNull();
  release.resolve();
  const { menu } = await opening;
  await expect(
    menu.findByRole("radio", { name: privateChoice }),
  ).resolves.toBeChecked();
});
test("hosted-site-sharing-034 Forbidden permission settings disable every audience while keeping Copy available", async () => {
  const { button, menu } = await openSharing(context, { denyVisibility: true });
  await menu.findByText("Unable to load permissions");
  for (const name of [privateChoice, orgChoice, publicChoice]) {
    const audience = menu.getByRole("radio", { name });
    expect(audience).toBeDisabled();
    expect(audience).not.toBeChecked();
  }
  await expect(button("Copy link")).resolves.toBeEnabled();
});
test("hosted-site-sharing-035 A conflicting private edit preserves the confirmed public audience", async () => {
  const { menu, moveToOrg } = await openSharing(context);
  const old = await menu.findByRole("radio", { name: publicChoice });
  expect(old).toBeChecked();
  moveToOrg();
  click(menu.getByRole("radio", { name: privateChoice }));
  await screen.findByText("Another editor changed the audience");
  await waitFor(() => {
    return expect(old).toBeChecked();
  });
  expect(menu.getByRole("radio", { name: privateChoice })).not.toBeChecked();
});
test("hosted-site-sharing-040 Three rapid choices finish on Only me after the pending save settles", async () => {
  const held = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  const { button, menu } = await openSharing(context, {
    audience: "private",
    beforeWrite: async (choice) => {
      if (choice === "organization") {
        held.resolve();
        await release.promise;
      }
    },
  });
  const initial = await menu.findByRole("radio", { name: privateChoice });
  expect(initial).toBeChecked();
  click(menu.getByRole("radio", { name: orgChoice }));
  await held.promise;
  const group = menu.getByRole("radiogroup");
  expect(group).toHaveAttribute("aria-busy", "true");
  click(menu.getByRole("radio", { name: publicChoice }));
  click(initial);
  release.resolve();
  await waitFor(() => {
    return expect(group).toHaveAttribute("aria-busy", "false");
  });
  expect(initial).toBeChecked();
  await expect(button("Copy link")).resolves.toBeEnabled();
});

const confirmed = {
  name: "artifact_action_clicked",
  properties: {
    action: "banner_share",
    surface: "sidebar",
    target: "hosted_site",
    show_banner: true,
  },
} as const;
test("hosted-site-sharing-004 A free workspace keeps its banner when hiding it opens the plan chooser", async () => {
  const site = await openSharing(context, { free: true });
  const banner = await site.menu.findByRole("switch", {
    name: "Show Okou banner",
  });
  expect(banner).toBeChecked();
  click(banner);
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
  expect(banner).toBeChecked();
  expect(site.banner()).toBeTruthy();
});
test("hosted-site-sharing-014 The clipboard gets the public site and analytics retains an unknown banner preference", async () => {
  const { button, menu, clipboard, analytics } = await openSharing(context, {
    denyBanner: true,
  });
  await menu.findByText("Unable to load banner settings");
  expect(menu.queryByRole("switch")).toBeNull();
  click(await button("Copy link"));
  await button("Copied");
  expect(clipboard.writes).toStrictEqual([stable]);
  expect(analytics.events).toContainEqual(
    expect.objectContaining({
      ...confirmed,
      properties: { ...confirmed.properties, show_banner: "unknown" },
    }),
  );
  expect(menu.getByText("Unable to load banner settings")).toBeVisible();
});
test("hosted-site-sharing-018 A denied clipboard write reports failure and records the confirmed banner preference", async () => {
  const { button, menu, analytics } = await openSharing(context);
  await expect(menu.findByRole("switch")).resolves.toBeChecked();
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
    new Error("Clipboard denied"),
  );
  const copy = await button("Copy link");
  click(copy);
  await expect(screen.findByText("Failed to copy link")).resolves.toBeVisible();
  expect(copy).toBeEnabled();
  expect(analytics.events).toContainEqual(expect.objectContaining(confirmed));
});
test("hosted-site-sharing-019 Copy confirmation survives a failing analytics SDK", async () => {
  const { button, clipboard } = await openSharing(context);
  const error = new Error("Analytics temporarily unavailable");
  const attempted = context.mocks.deferred<void>();
  vi.mocked(posthog.capture).mockImplementation((event) => {
    if (event === "artifact_action_clicked") {
      attempted.resolve();
      throw error;
    }
    return undefined;
  });
  const report = (event: ErrorEvent) => {
    if (event.error === error) {
      event.preventDefault();
    }
  };
  window.addEventListener("error", report);
  try {
    click(await button("Copy link"));
    await attempted.promise;
    await expect(button("Copied")).resolves.toBeVisible();
    expect(clipboard.writes).toStrictEqual([stable]);
  } finally {
    window.removeEventListener("error", report);
  }
});
test("hosted-site-sharing-024 A conflicting banner edit keeps the confirmed on preference for the next copy", async () => {
  const { button, menu, clipboard, analytics, replaceBannerRevision } =
    await openSharing(context);
  const toggle = await menu.findByRole("switch");
  expect(toggle).toBeChecked();
  replaceBannerRevision();
  click(toggle);
  await screen.findByText("Another editor changed the banner");
  await waitFor(() => {
    return expect(toggle).toBeEnabled();
  });
  expect(toggle).toBeChecked();
  click(await button("Copy link"));
  await button("Copied");
  expect(clipboard.writes).toStrictEqual([stable]);
  expect(analytics.events).toContainEqual(expect.objectContaining(confirmed));
});

const invitedSiteId = "a9100000-0000-4000-8000-000000000054";

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
      expect(params).toMatchObject({ kind: "site", id: invitedSiteId });
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
