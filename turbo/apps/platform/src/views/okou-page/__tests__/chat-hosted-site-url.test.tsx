import { now } from "../../../lib/time.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  hostedDomainSettingsSchema,
  hostedDomainSetupSchema,
} from "@okouai/api-contracts/contracts/hosted-site-domains";
import type { infer as zInfer } from "zod";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  setupPage,
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactSummary,
  artifactRun,
  hostedSiteArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  findNamedButton,
  findNamedLink,
  getNamedButton,
} from "./chat-attachment-test-helpers.ts";
import { openResources } from "./chat-resources-test-helpers.ts";

const context = testContext();
function checking(id: string) {
  return {
    id,
    expiresAt: new Date(now() + 30 * 60_000).toISOString(),
    status: "checking" as const,
  };
}
const title = "Quarterly launch report";
const original = "launch-recap";
const address = (slug: string) => {
  return "https://" + slug + ".okou.app";
};
const deployment = address("dpl-8a4d4487-18c0-44cd-a09d-206056d499b0");
const siteId = "be311386-caaa-4bfb-a74a-7d694c27c41e";
async function publishedReport(
  customDomains = false,
  setup?: zInfer<typeof hostedDomainSetupSchema>,
  publication?: () => { readonly title: string; readonly slug: string },
) {
  let slug = original;
  const site = () => {
    const currentSlug = publication?.().slug ?? slug;
    return {
      siteId,
      artifactId: "d8064466-f246-4524-8e90-3655890190fe",
      publicSlug: currentSlug,
      url: address(currentSlug),
      isActive: true,
    };
  };
  const item = {
    ...artifactSummary(
      "d8064466-f246-4524-8e90-3655890190fe",
      "hosted-site",
      title,
    ),
    sourceUrl: deployment,
    aliasUrl: address(original),
  };
  const run = artifactRun({
    artifactId: item.id,
    fileId: siteId,
    filename: "index.html",
    contentType: "text/html",
    url: deployment,
  });
  mockArtifactConversation(context, {
    catalog: [item],
    artifactRuns: () => {
      return [
        {
          ...run,
          files: [
            {
              ...run.files[0]!,
              title,
              artifactKind: "hosted-site",
              aliasUrl: address(original),
            },
          ],
        },
      ];
    },
    getDetail: () => {
      const current = publication?.() ?? { title, slug };
      return hostedSiteArtifactDetail(
        { ...item, title: current.title },
        {
          siteId,
          slug: current.slug,
          url: address(current.slug),
        },
      );
    },
    chatEvents: [
      {
        role: "assistant",
        content: "[Read the launch report](" + deployment + ")",
        createdAt: "2026-10-10T18:00:00Z",
        runId: NAVIGATION_ARTIFACT_RUN_ID,
      },
    ],
  });
  context.mocks.api(hostContract.siteDomainSetup, ({ respond }) => {
    return respond(
      200,
      setup ?? {
        providerName: "Cloudflare",
        controlPanelUrl: "https://dash.cloudflare.com/",
        automaticUrl: null,
        status: "manual",
      },
    );
  });
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site());
  });
  context.mocks.api(artifactAccessContract.getVisibility, ({ respond }) => {
    const current = site();
    return respond(200, {
      artifactId: siteId,
      kind: "hosted-site",
      visibility: "public",
      ownerUrl: current.url,
      shareUrl: current.url,
      shortUrl: null,
      organization: { id: "org_default", name: "Default Org" },
    });
  });
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return respond(200, { siteId, showBanner: true, revision: null });
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ query, respond }) => {
    return respond(200, { available: query.publicSlug !== slug });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
    if (body.expectedPublicSlug !== slug) {
      return respond(409, {
        error: { code: "CONFLICT", message: "The site was already renamed" },
      });
    }
    slug = body.publicSlug;
    return respond(200, site());
  });
  await setupPage({
    context,
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
    featureSwitches: {
      [FeatureSwitchKey.HostedSiteCustomDomains]: customDomains,
    },
    host: "app.okou.ai",
  });
  click(await findNamedLink("Read the launch report"));
  const preview = await screen.findByTestId("artifact-sidebar");
  await findNamedLink(title, preview);
  return preview;
}

test("chat-hosted-site-url-002 shows the owner's current banner and public audience in Share", async () => {
  const preview = await publishedReport();
  click(await findNamedButton("Share artifact", preview));
  const toggle = await screen.findByRole("switch", {
    name: "Show Okou banner",
  });
  const menu = toggle.closest<HTMLElement>('[role="dialog"]')!;
  expect(toggle).toBeEnabled();
  expect(toggle).toBeChecked();
  const audience = within(menu).getByLabelText("Anyone with the link");
  expect(audience).toBeEnabled();
  expect(audience).toBeChecked();
});

test("chat-hosted-site-url-004 follows both saved addresses through the preview and Resources", async () => {
  const viewer = await publishedReport();
  const user = userEvent.setup({ delay: null, writeToClipboard: false });
  for (const [current, next] of [
    [original, "renamed-site"],
    ["renamed-site", "final-site"],
  ] as const) {
    click(await findNamedButton("Share artifact", viewer));
    await screen.findByText(current + ".okou.app");
    click(getNamedButton("Customize URL"));
    await fill(await screen.findByLabelText("Website URL"), next);
    await screen.findByText("Available");
    click(getNamedButton("Save"));
    const url = address(next);
    await waitFor(() => {
      expect(
        within(viewer).getByText(title, { selector: "a" }),
      ).toHaveAttribute("href", url + "/");
    });
    const shareCopy = await findNamedButton("Copy link");
    const clipboard = context.mocks.browser.clipboardWriteText();
    click(shareCopy);
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([url]);
    });
    await user.keyboard("{Escape}");
  }
  click(await findNamedButton("Close artifact", viewer));
  const resources = await openResources();
  const row = (await within(resources).findByText(title)).closest("li")!;
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getNamedButton("Copy link", row));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([address("final-site")]);
  });
});

test("Closing a website cancels its pending domain read and reopening starts a fresh share session", async () => {
  const began = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  let hold = true;
  context.mocks.api(hostContract.siteDomains, async ({ request, respond }) => {
    if (hold) {
      hold = false;
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      began.resolve();
      await aborted.promise;
    }
    return respond(200, {
      siteId,
      defaultUrl: address(original),
      effectiveUrl: address(original),
      selectedDomainId: null,
      revision: "00000000-0000-4000-8000-000000000053",
      allowed: true,
      domains: [],
    });
  });
  const preview = await publishedReport(true);
  await openHostedSiteShare(preview);
  click(await findNamedButton("Customize URL"));
  await began.promise;
  click(getNamedButton("Close artifact", preview));
  await aborted.promise;
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });

  click(await findNamedLink("Read the launch report"));
  const reopened = await screen.findByTestId("artifact-sidebar");
  const menu = await openHostedSiteShare(reopened);
  expect(within(menu).queryByLabelText("Website URL")).toBeNull();
  click(await findNamedButton("Customize URL", menu));
  await expect(screen.findByLabelText("Website URL")).resolves.toHaveValue(
    original,
  );
});

test("Opening a website from chat Resources initializes its sharing settings", async () => {
  const preview = await publishedReport();
  click(getNamedButton("Close artifact", preview));
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
  const resources = await openResources();
  const artifact = await within(resources).findByText(title);
  click(artifact.closest("button")!);
  const catalogPreview = await screen.findByTestId("artifact-sidebar");
  const menu = await openHostedSiteShare(catalogPreview);
  expect(within(menu).getByLabelText("Anyone with the link")).toBeChecked();
  await expect(
    within(menu).findByRole("switch", { name: "Show Okou banner" }),
  ).resolves.toBeChecked();
});

test("A publication notification updates sharing in the chat catalog preview", async () => {
  let publication = { title, slug: original };
  const preview = await publishedReport(false, undefined, () => {
    return publication;
  });
  click(getNamedButton("Close artifact", preview));
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
  const resources = await openResources();
  click((await within(resources).findByText(title)).closest("button")!);
  const catalogPreview = await screen.findByTestId("artifact-sidebar");
  await findNamedButton("Share artifact", catalogPreview);
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
  });
  publication = { title: "Updated launch report", slug: "republished-report" };
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", {
      artifactId: "d8064466-f246-4524-8e90-3655890190fe",
    });
  });
  await within(screen.getByTestId("artifact-sidebar")).findByText(
    publication.title,
  );
  const menu = await openHostedSiteShare(
    screen.getByTestId("artifact-sidebar"),
  );
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(await findNamedButton("Copy link", menu));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([address(publication.slug)]);
  });
});

function tabNamed(name: string, container: HTMLElement) {
  const tab = queryAllByRoleFast("tab", container).find((item) => {
    return item.textContent?.startsWith(name);
  });
  if (!tab) {
    throw new Error(`Tab not found: ${name}`);
  }
  return tab;
}

async function openHostedSiteShare(preview: HTMLElement) {
  click(await findNamedButton("Share artifact", preview));
  const menu = await screen.findByRole("dialog", { name: "Share artifact" });
  await within(menu).findByText("Who can access");
  return menu;
}
test("custom domain verification stays manual and saves directly from the verification view", async () => {
  const domainId = "00000000-0000-4000-8000-000000000051";
  const revision = "00000000-0000-4000-8000-000000000052";
  let settings: zInfer<typeof hostedDomainSettingsSchema> = {
    siteId,
    defaultUrl: "https://launch-recap.okou.app",
    effectiveUrl: "https://launch-recap.okou.app",
    selectedDomainId: null,
    revision,
    allowed: true,
    domains: [],
  };
  let verifies = 0;
  let saves = 0;
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, settings);
  });
  context.mocks.api(hostContract.addSiteDomain, ({ body, respond }) => {
    settings = {
      ...settings,
      domains: [
        {
          id: domainId,
          hostname: body.hostname,
          revision,
          ready: false,
          removing: false,
          records: [
            {
              type: "TXT",
              name: "_okou-challenge.www.customer-example.net",
              value: "okou-verification=demo",
            },
            {
              type: "CNAME",
              name: "www.customer-example.net",
              value: "connect.okou.app",
            },
          ],
          verification: null,
        },
      ],
    };
    return respond(200, settings);
  });
  context.mocks.api(hostContract.verifySiteDomain, ({ respond }) => {
    verifies++;
    settings = {
      ...settings,
      domains: settings.domains.map((domain) => {
        return { ...domain, ready: true };
      }),
    };
    return respond(200, settings);
  });
  context.mocks.api(hostContract.selectSiteDomain, ({ body, respond }) => {
    saves++;
    expect(body.domainId).toBe(domainId);
    settings = {
      ...settings,
      selectedDomainId: domainId,
      effectiveUrl: "https://www.customer-example.net",
    };
    return respond(200, settings);
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const preview = await publishedReport(true);
  const menu = await openHostedSiteShare(preview);
  click(getNamedButton("Customize URL", menu));
  await within(menu).findByLabelText("Website URL");
  expect(
    within(menu).queryByRole("combobox", { name: "Domain" }),
  ).not.toBeInTheDocument();
  expect(tabNamed("Okou URL", menu)).toHaveAttribute("aria-selected", "true");
  click(tabNamed("Custom domain", menu));
  const input = await within(menu).findByPlaceholderText("www.example.com");
  fireEvent.change(input, { target: { value: "www.customer-example.net" } });
  expect(input).toHaveValue("www.customer-example.net");
  expect(getNamedButton("Continue", menu)).toBeEnabled();
  click(getNamedButton("Continue", menu));
  await within(menu).findByRole("heading", { name: "Set up DNS records" });
  expect(
    within(menu).getByRole("heading", { name: "www.customer-example.net" }),
  ).toBeInTheDocument();
  expect(verifies).toBe(0);
  click(getNamedButton("Verify", menu));
  await within(menu).findByRole("heading", { name: "Domain ready" });
  expect(verifies).toBe(1);
  expect(saves).toBe(0);
  expect(within(menu).queryByText("Continue")).not.toBeInTheDocument();
  expect(within(menu).queryByText("Remove")).not.toBeInTheDocument();
  expect(getNamedButton("Cancel", menu)).toBeEnabled();
  click(getNamedButton("Save", menu));
  await waitFor(() => {
    return expect(getNamedButton("Copy link", menu)).toBeEnabled();
  });
  click(getNamedButton("Copy link", menu));
  await waitFor(() => {
    return expect(clipboard.writes.at(-1)).toBe(
      "https://www.customer-example.net",
    );
  });
  expect(saves).toBe(1);
  click(getNamedButton("Customize URL", menu));
  await waitFor(() => {
    expect(tabNamed("Custom domain", menu)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  await expect(
    findNamedButton("Manage www.customer-example.net", menu),
  ).resolves.toHaveAttribute("aria-current", "true");
  expect(getNamedButton("Remove www.customer-example.net", menu)).toBeEnabled();
  click(tabNamed("Okou URL", menu));
  await expect(
    within(menu).findByLabelText("Website URL"),
  ).resolves.toHaveValue(original);
  expect(within(menu).getByText(".okou.app")).toBeInTheDocument();
  click(getNamedButton("Cancel", menu));
  click(
    await waitFor(() => {
      return getNamedButton("Copied", menu);
    }),
  );
  await waitFor(() => {
    expect(clipboard.writes.at(-1)).toBe("https://www.customer-example.net");
  });
  expect(saves).toBe(1);
});

test("pending domains are managed as full hostnames and cannot replace the sharing address", async () => {
  const domainId = "00000000-0000-4000-8000-000000000061";
  const revision = "00000000-0000-4000-8000-000000000062";
  let settings: zInfer<typeof hostedDomainSettingsSchema> = {
    siteId,
    defaultUrl: "https://launch-recap.okou.app",
    effectiveUrl: "https://launch-recap.okou.app",
    selectedDomainId: null,
    revision,
    allowed: true,
    domains: [
      {
        id: domainId,
        hostname: "pending.customer-example.net",
        revision,
        ready: false,
        removing: false,
        records: [],
        verification: null,
      },
    ],
  };
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, settings);
  });
  let removals = 0;
  context.mocks.api(hostContract.removeSiteDomain, ({ respond }) => {
    removals++;
    settings = { ...settings, domains: [] };
    return respond(200, settings);
  });
  const preview = await publishedReport(true);
  const menu = await openHostedSiteShare(preview);
  click(getNamedButton("Customize URL", menu));
  click(
    await waitFor(() => {
      return tabNamed("Custom domain", menu);
    }),
  );
  await expect(
    findNamedButton("Manage pending.customer-example.net", menu),
  ).resolves.toBeEnabled();
  expect(getNamedButton("Save", menu)).toBeDisabled();
  expect(within(menu).queryByRole("combobox")).not.toBeInTheDocument();
  click(await within(menu).findByText("pending.customer-example.net"));
  await within(menu).findByRole("heading", {
    name: "pending.customer-example.net",
  });
  expect(getNamedButton("Verify", menu)).toBeEnabled();
  click(getNamedButton("Cancel", menu));
  await expect(
    findNamedButton("Manage pending.customer-example.net", menu),
  ).resolves.toBeEnabled();
  click(getNamedButton("Remove pending.customer-example.net", menu));
  let confirmation = await screen.findByRole("dialog", { name: /Remove/ });
  click(getNamedButton("Cancel", confirmation));
  expect(removals).toBe(0);
  click(getNamedButton("Remove pending.customer-example.net", menu));
  confirmation = await screen.findByRole("dialog", { name: /Remove/ });
  click(getNamedButton("Remove", confirmation));
  await waitFor(() => {
    expect(removals).toBe(1);
  });
  await waitFor(() => {
    expect(
      within(menu).queryByText("pending.customer-example.net"),
    ).not.toBeInTheDocument();
  });
  click(tabNamed("Okou URL", menu));
  await expect(
    within(menu).findByLabelText("Website URL"),
  ).resolves.toHaveValue(original);
});

test("a workspace without an active subscription cannot select an existing verified custom domain", async () => {
  const revision = "00000000-0000-4000-8000-000000000072";
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, {
      siteId,
      defaultUrl: "https://launch-recap.okou.app",
      effectiveUrl: "https://launch-recap.okou.app",
      selectedDomainId: null,
      revision,
      allowed: false,
      domains: [
        {
          id: "00000000-0000-4000-8000-000000000071",
          hostname: "verified.customer-example.net",
          revision,
          ready: true,
          removing: false,
          records: [],
          verification: null,
        },
      ],
    });
  });
  const preview = await publishedReport(true);
  const menu = await openHostedSiteShare(preview);
  click(getNamedButton("Customize URL", menu));
  click(
    await waitFor(() => {
      return tabNamed("Custom domain", menu);
    }),
  );
  await expect(
    findNamedButton("Manage verified.customer-example.net", menu),
  ).resolves.toBeEnabled();
  expect(getNamedButton("Save", menu)).toBeDisabled();
  expect(
    getNamedButton("Manage verified.customer-example.net", menu),
  ).toBeEnabled();
});

test("the timeline separates DNS actions from automatic progress and applies the ready address only on Save", async () => {
  const hostname = "www.customer-example.net";
  const domainId = "00000000-0000-4000-8000-000000000091";
  const revision = "00000000-0000-4000-8000-000000000092";
  const checkedAt = "2026-11-25T00:00:00Z";
  const records = [
    {
      type: "TXT" as const,
      name: `_okou-challenge.${hostname}`,
      value: "okou-verification=demo",
    },
    { type: "CNAME" as const, name: hostname, value: "connect.okou.app" },
  ];
  const passed = { status: "passed" as const, message: "Verified" };
  let settings: zInfer<typeof hostedDomainSettingsSchema> = {
    siteId,
    defaultUrl: address(original),
    effectiveUrl: address(original),
    selectedDomainId: null,
    revision,
    allowed: true,
    domains: [
      {
        id: domainId,
        hostname,
        revision,
        ready: false,
        removing: false,
        records,
        verification: {
          status: "incomplete",
          eligibleForSelection: false,
          checkedAt,
          validationRecords: [],
          checks: {
            ownership: passed,
            dns: passed,
            certificate: {
              status: "pending",
              message: "HTTPS is being configured automatically",
            },
            provider: {
              status: "pending",
              message:
                "Your domain is still activating. Wait, then click Verify again.",
            },
            route: {
              status: "not_checked",
              message: "Waiting for domain activation",
            },
          },
          recordChecks: records.map((record, index) => {
            return {
              ...record,
              checkedAt,
              observedValues: index === 1 ? [] : [record.value],
              status: index === 1 ? ("pending" as const) : ("passed" as const),
              message:
                index === 1
                  ? "The record value does not match. Update it at your DNS provider, then click Verify."
                  : "Record matches",
            };
          }),
        },
      },
    ],
  };
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, settings);
  });
  let verifiedOnce = false;

  const verificationStarted = context.mocks.deferred<void>();
  const finishVerification = context.mocks.deferred<void>();
  context.mocks.api(hostContract.verifySiteDomain, async ({ respond }) => {
    if (!verifiedOnce) {
      verificationStarted.resolve();
      await finishVerification.promise;
    }
    const ready = false;
    verifiedOnce = true;
    settings = {
      ...settings,
      domains: settings.domains.map((domain) => {
        return {
          ...domain,
          ready,
          verification: {
            ...domain.verification!,
            status: ready ? "ready" : "incomplete",
            eligibleForSelection: ready,
            automatic: checking(domainId),
            checks: {
              ...domain.verification!.checks,
              certificate: ready
                ? passed
                : domain.verification!.checks.certificate,
              provider: ready ? passed : domain.verification!.checks.provider,
              route: ready ? passed : domain.verification!.checks.route,
            },
            recordChecks: records.map((record) => {
              return {
                ...record,
                ...passed,
                observedValues: [record.value],
                checkedAt,
              };
            }),
          },
        };
      }),
    };
    return respond(200, settings);
  });
  context.mocks.api(hostContract.selectSiteDomain, ({ body, respond }) => {
    expect(body.domainId).toBe(domainId);
    settings = {
      ...settings,
      selectedDomainId: domainId,
      effectiveUrl: `https://${hostname}`,
    };
    return respond(200, settings);
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const preview = await publishedReport(true);
  const menu = await openHostedSiteShare(preview);
  click(getNamedButton("Customize URL", menu));
  click(
    await waitFor(() => {
      return tabNamed("Custom domain", menu);
    }),
  );
  click(await findNamedButton(`Manage ${hostname}`, menu));
  await within(menu).findByText("Set up DNS records");
  expect(within(menu).getAllByText("Passed")).toHaveLength(1);
  expect(within(menu).getByText("okou-verification=demo")).toBeVisible();
  expect(within(menu).getByText("connect.okou.app")).toBeVisible();
  expect(getNamedButton("Verify again", menu)).toBeEnabled();
  expect(
    queryAllByRoleFast("button", menu).find((button) => {
      return button.textContent === "Save";
    }),
  ).toBeUndefined();
  const name = `_okou-challenge.${hostname}`;
  click(getNamedButton(`Copy TXT name ${name}`, menu));
  await waitFor(() => {
    return expect(clipboard.writes.at(-1)).toBe(name);
  });
  click(getNamedButton(`Copy TXT value ${name}`, menu));
  await waitFor(() => {
    return expect(clipboard.writes.at(-1)).toBe("okou-verification=demo");
  });
  await expect(
    findNamedLink("Open Cloudflare DNS", menu),
  ).resolves.toHaveAttribute("href", "https://dash.cloudflare.com/");
  expect(
    queryAllByRoleFast("link", menu).find((link) => {
      return link.textContent?.includes("Configure with");
    }),
  ).toBeUndefined();
  const user = userEvent.setup({ delay: null, writeToClipboard: false });
  await user.click(getNamedButton("Verify again", menu));
  await verificationStarted.promise;
  expect(within(menu).getByRole("img", { name: "Checking…" })).toBeVisible();
  expect(getNamedButton("Verify again", menu)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  finishVerification.resolve();
  const connection = await findNamedButton("Connecting domain", menu);
  expect(connection).toHaveAttribute("aria-expanded", "true");
  expect(within(menu).getAllByRole("img", { name: "Checking…" })).toHaveLength(
    3,
  );
  const route = within(menu).getByText("Website routing").closest("li")!;
  expect(within(route).getByRole("img", { name: "Waiting" })).toBeVisible();
  click(connection);
  expect(connection).toHaveAttribute("aria-expanded", "false");
  expect(within(menu).getAllByRole("img", { name: "Checking…" })).toHaveLength(
    1,
  );
  expect(
    queryAllByRoleFast("button", menu).some((button) => {
      return button.textContent === "Verify again";
    }),
  ).toBeFalsy();
  click(getNamedButton("DNS is configured", menu));
  await within(menu).findByText("okou-verification=demo");
  expect(within(menu).getByText("connect.okou.app")).toBeVisible();
  const topic = `hostedSiteDomainsChanged:${siteId}`;
  await waitFor(() => {
    return expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  click(connection);
  settings = {
    ...settings,
    domains: settings.domains.map((domain) => {
      return {
        ...domain,
        verification: {
          ...domain.verification!,
          checks: {
            ...domain.verification!.checks,
            provider: passed,
            certificate: passed,
            route: { status: "pending", message: "Checking website routing" },
          },
        },
      };
    }),
  };
  await act(() => {
    return context.mocks.ably.trigger(topic);
  });
  await waitFor(() => {
    const routing = within(menu).getByText("Website routing").closest("li")!;
    expect(
      within(routing).getByRole("img", { name: "Checking…" }),
    ).toBeVisible();
  });
  settings = {
    ...settings,
    domains: settings.domains.map((domain) => {
      return {
        ...domain,
        ready: true,
        verification: {
          ...domain.verification!,
          automatic: undefined,
          status: "ready",
          eligibleForSelection: true,
          checks: {
            ownership: passed,
            dns: passed,
            provider: passed,
            certificate: passed,
            route: passed,
          },
        },
      };
    }),
  };
  await act(() => {
    return context.mocks.ably.trigger(topic);
  });
  await findNamedButton("Save", menu);
  expect(within(menu).getByText(`https://${hostname}`)).toBeInTheDocument();
  click(getNamedButton("Copy to clipboard", menu));
  await waitFor(() => {
    return expect(clipboard.writes.at(-1)).toBe(`https://${hostname}`);
  });
  click(await findNamedButton("Save", menu));
  await waitFor(() => {
    expect(getNamedButton("Copy link", menu)).toBeEnabled();
  });
  click(getNamedButton("Copy link", menu));
  await waitFor(() => {
    expect(clipboard.writes.at(-1)).toBe(`https://${hostname}`);
  });
});

test("DNS lookup errors retain the records and retry action until background verification starts", async () => {
  const hostname = "retry.customer-example.net";
  const domainId = "00000000-0000-4000-8000-000000000095";
  const revision = "00000000-0000-4000-8000-000000000096";
  const checkedAt = "2026-11-25T00:00:00Z";
  const unavailable = {
    status: "unavailable" as const,
    message: "DNS lookup unavailable. Try Verify again.",
  };
  const passed = { status: "passed" as const, message: "Verified" };
  const records = [
    {
      type: "TXT" as const,
      name: `_okou-challenge.${hostname}`,
      value: "okou-verification=retry",
    },
    { type: "CNAME" as const, name: hostname, value: "connect.okou.app" },
  ];
  let settings: zInfer<typeof hostedDomainSettingsSchema> = {
    siteId,
    defaultUrl: address(original),
    effectiveUrl: address(original),
    selectedDomainId: null,
    revision,
    allowed: true,
    domains: [
      {
        id: domainId,
        hostname,
        revision,
        ready: false,
        removing: false,
        records,
        verification: {
          status: "unavailable",
          eligibleForSelection: false,
          checkedAt,
          validationRecords: [],
          recordChecks: records.map((record) => {
            return {
              ...record,
              ...unavailable,
              observedValues: [],
              checkedAt,
            };
          }),
          checks: {
            ownership: unavailable,
            dns: unavailable,
            provider: unavailable,
            certificate: unavailable,
            route: unavailable,
          },
        },
      },
    ],
  };
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, settings);
  });
  let unavailableOnce = true;
  context.mocks.api(hostContract.verifySiteDomain, ({ respond }) => {
    if (unavailableOnce) {
      unavailableOnce = false;
      return respond(503, {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "DNS lookup is temporarily unavailable. Try again.",
        },
      });
    }
    settings = {
      ...settings,
      domains: settings.domains.map((domain) => {
        return {
          ...domain,
          records,
          verification: {
            status: "incomplete",
            automatic: checking(domainId),
            eligibleForSelection: false,
            checkedAt,
            validationRecords: [],
            recordChecks: records.map((record) => {
              return {
                ...record,
                ...passed,
                observedValues: [record.value],
                checkedAt,
              };
            }),
            checks: {
              ownership: passed,
              dns: passed,
              provider: passed,
              certificate: {
                status: "pending",
                message: "HTTPS is being configured automatically",
              },
              route: { status: "not_checked", message: "Waiting for HTTPS" },
            },
          },
        };
      }),
    };
    return respond(200, settings);
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const preview = await publishedReport(true, {
    providerName: "Cloudflare",
    controlPanelUrl: "https://dash.cloudflare.com/",
    automaticUrl: "https://dash.cloudflare.com/domain-connect?sig=fixture",
    status: "supported",
  });
  const menu = await openHostedSiteShare(preview);
  click(getNamedButton("Customize URL", menu));
  click(
    await waitFor(() => {
      return tabNamed("Custom domain", menu);
    }),
  );
  click(await findNamedButton(`Manage ${hostname}`, menu));
  await within(menu).findByRole("heading", { name: "Set up DNS records" });
  expect(within(menu).getByText("okou-verification=retry")).toBeVisible();
  click(getNamedButton("Verify again", menu));
  await within(menu).findByText(
    "DNS lookup is temporarily unavailable. Try again.",
  );
  click(getNamedButton("Verify again", menu));
  await findNamedButton("Connecting domain", menu);
  click(getNamedButton("DNS is configured", menu));
  await expect(
    within(menu).findByText("connect.okou.app"),
  ).resolves.toBeVisible();
  click(getNamedButton("Close", menu));
  const reopened = await openHostedSiteShare(preview);
  await waitFor(() => {
    expect(getNamedButton("Copy link", reopened)).toBeEnabled();
  });
  click(getNamedButton("Copy link", reopened));
  await waitFor(() => {
    expect(clipboard.writes.at(-1)).toBe(address(original));
  });
});

test("reopening catches up without a verification POST, and an expired attempt can be retried", async () => {
  const hostname = "automatic.customer-example.net";
  const domainId = "00000000-0000-4000-8000-000000000097";
  const revision = "00000000-0000-4000-8000-000000000098";
  const checkedAt = "2026-11-26T00:00:00Z";
  const records = [
    {
      type: "TXT" as const,
      name: `_okou-challenge.${hostname}`,
      value: "okou-verification=automatic",
    },
    { type: "CNAME" as const, name: hostname, value: "connect.okou.app" },
  ];
  let settings: zInfer<typeof hostedDomainSettingsSchema> = {
    siteId,
    defaultUrl: address(original),
    effectiveUrl: address(original),
    selectedDomainId: null,
    revision,
    allowed: true,
    domains: [
      {
        id: domainId,
        hostname,
        revision,
        ready: false,
        removing: false,
        records,
        verification: null,
      },
    ],
  };
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, settings);
  });
  let requests = 0;
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(hostContract.verifySiteDomain, ({ respond }) => {
    requests++;
    const ready = requests === 2;
    const passed = { status: "passed" as const, message: "Verified" };
    const pending = {
      status: "pending" as const,
      message: "HTTPS is being configured automatically",
    };
    settings = {
      ...settings,
      domains: settings.domains.map((domain) => {
        return {
          ...domain,
          ready,
          verification: {
            status: ready ? "ready" : "incomplete",
            checkedAt,
            automatic: ready ? undefined : checking(domainId),
            eligibleForSelection: ready,
            validationRecords: [],
            recordChecks: records.map((record) => {
              return {
                ...record,
                ...passed,
                observedValues: [record.value],
                checkedAt,
              };
            }),
            checks: {
              ownership: passed,
              dns: passed,
              provider: passed,
              certificate: ready ? passed : pending,
              route: ready ? passed : pending,
            },
          },
        };
      }),
    };
    return respond(200, settings);
  });
  const preview = await publishedReport(true);
  const menu = await openHostedSiteShare(preview);
  click(getNamedButton("Customize URL", menu));
  click(
    await waitFor(() => {
      return tabNamed("Custom domain", menu);
    }),
  );
  click(await findNamedButton(`Manage ${hostname}`, menu));
  click(await findNamedButton("Verify", menu));
  await findNamedButton("Connecting domain", menu);
  click(getNamedButton("Close", menu));
  await waitFor(() => {
    return expect(menu).not.toBeInTheDocument();
  });
  settings = {
    ...settings,
    domains: settings.domains.map((domain) => {
      return {
        ...domain,
        verification: {
          ...domain.verification!,
          automatic: { ...checking(domainId), status: "timed_out" },
        },
      };
    }),
  };
  const reopened = await openHostedSiteShare(preview);
  click(getNamedButton("Customize URL", reopened));
  click(
    await waitFor(() => {
      return tabNamed("Custom domain", reopened);
    }),
  );
  click(await findNamedButton(`Manage ${hostname}`, reopened));
  await findNamedButton("Verification timed out", reopened);
  expect(within(reopened).queryByRole("img", { name: "Checking…" })).toBeNull();
  expect(requests).toBe(1);
  click(getNamedButton("Verify again", reopened));
  await findNamedButton("Save", reopened);
  expect(requests).toBe(2);
  click(getNamedButton("Cancel", reopened));
  click(getNamedButton("Cancel", reopened));
  await waitFor(() => {
    return expect(getNamedButton("Copy link", reopened)).toBeEnabled();
  });
  click(getNamedButton("Copy link", reopened));
  await waitFor(() => {
    return expect(clipboard.writes.at(-1)).toBe(address(original));
  });
});

test.each(["list", "timeline"] as const)(
  "the %s catches up while the entry read is stalled and reconciles a missed final push once at expiry",
  async (view) => {
    const hostname = "catch-up.customer-example.net";
    const id = "00000000-0000-4000-8000-000000000111";
    const checkedAt = new Date(now()).toISOString();
    const passed = { status: "passed" as const, message: "Verified" };
    const pending = { status: "pending" as const, message: "Pending" };
    function snapshot(
      ready: boolean,
      expiresAt?: string,
    ): zInfer<typeof hostedDomainSettingsSchema> {
      return {
        siteId,
        allowed: true,
        revision: id,
        selectedDomainId: null,
        defaultUrl: address(original),
        effectiveUrl: address(original),
        domains: [
          {
            id,
            revision: id,
            hostname,
            ready,
            removing: false,
            records: [],
            verification: {
              status: ready ? "ready" : "incomplete",
              automatic: expiresAt
                ? { id, status: "checking", expiresAt }
                : undefined,
              eligibleForSelection: ready,
              checkedAt,
              recordChecks: [],
              validationRecords: [],
              checks: {
                ownership: passed,
                dns: passed,
                provider: passed,
                certificate: ready ? passed : pending,
                route: ready ? passed : pending,
              },
            },
          },
        ],
      };
    }
    const before = snapshot(false);
    const checkingDomain = snapshot(false, checking(id).expiresAt);
    const expired = snapshot(false, checkedAt);
    const ready = snapshot(true);
    const releaseEntry = context.mocks.deferred<void>();
    const releaseFinal = context.mocks.deferred<void>();
    let read = () => {
      return Promise.resolve(before);
    };
    let finalReads = 0;
    context.mocks.api(hostContract.siteDomains, async ({ respond }) => {
      return respond(200, await read());
    });
    const preview = await publishedReport(true);
    const menu = await openHostedSiteShare(preview);
    click(getNamedButton("Customize URL", menu));
    const tab = await waitFor(() => {
      return tabNamed("Custom domain", menu);
    });
    read = async () => {
      read = () => {
        return Promise.resolve(checkingDomain);
      };
      await releaseEntry.promise;
      return before;
    };
    click(tab);
    await within(menu).findByText("Connecting domain");
    if (view === "timeline") {
      click(getNamedButton(`Manage ${hostname}`, menu));
      await findNamedButton("Connecting domain", menu);
    }
    read = () => {
      read = async () => {
        finalReads++;
        await releaseFinal.promise;
        return ready;
      };
      return Promise.resolve(expired);
    };
    await act(() => {
      return context.mocks.ably.trigger(`hostedSiteDomainsChanged:${siteId}`);
    });
    const timeoutLabel =
      view === "timeline"
        ? await findNamedButton("Verification timed out", menu)
        : await within(menu).findByText("Verification timed out");
    expect(timeoutLabel).toBeVisible();
    expect(within(menu).queryByRole("img", { name: "Checking…" })).toBeNull();
    await waitFor(() => {
      expect(finalReads).toBe(1);
    });
    releaseFinal.resolve();
    const readyControl =
      view === "timeline"
        ? await findNamedButton("Save", menu)
        : await within(menu).findByText("HTTPS ready");
    await act(() => {
      releaseEntry.resolve();
      return releaseEntry.promise;
    });
    expect(finalReads).toBe(1);
    expect(within(menu).queryByText("Verification timed out")).toBeNull();
    expect(readyControl).toBeVisible();
  },
);

test.each(["Cloudflare", "Vercel"] as const)(
  "%s DNS setup opens signed provider consent before verification",
  async (provider) => {
    const hostname = "www.customer-example.net";
    const domainId = "00000000-0000-4000-8000-000000000093";
    const revision = "00000000-0000-4000-8000-000000000094";
    const settings: zInfer<typeof hostedDomainSettingsSchema> = {
      siteId,
      defaultUrl: address(original),
      effectiveUrl: address(original),
      selectedDomainId: null,
      revision,
      allowed: true,
      domains: [
        {
          id: domainId,
          hostname,
          revision,
          ready: false,
          removing: false,
          records: [],
          verification: null,
        },
      ],
    };
    context.mocks.api(hostContract.siteDomains, ({ respond }) => {
      return respond(200, settings);
    });
    const origin =
      provider === "Cloudflare"
        ? "https://dash.cloudflare.com"
        : "https://vercel.com";
    const automaticUrl = `${origin}/domain-connect/v2/domainTemplates/providers/okou.ai/services/hosted-site/apply?domain=customer-example.net&sig=test`;
    const preview = await publishedReport(true, {
      providerName: provider,
      controlPanelUrl: origin,
      automaticUrl,
      status: "supported",
    });
    const menu = await openHostedSiteShare(preview);
    click(getNamedButton("Customize URL", menu));
    click(
      await waitFor(() => {
        return tabNamed("Custom domain", menu);
      }),
    );
    click(await findNamedButton(`Manage ${hostname}`, menu));
    const link = await findNamedLink(`Configure with ${provider}`, menu);
    expect(link).toHaveRole("link");
    expect(link).toHaveAttribute("href", automaticUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(
      within(menu).getByText(
        "Confirm the ownership TXT and website CNAME at your DNS provider. HTTPS is configured automatically, then return here and click Verify.",
      ),
    ).toBeInTheDocument();
    expect(getNamedButton("Verify", menu)).toBeEnabled();
    expect(getNamedButton("Verify", menu)).toBeEnabled();
  },
);
