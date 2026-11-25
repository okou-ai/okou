import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  hostedDomainSettingsSchema,
  hostedDomainSetupSchema,
} from "@okouai/api-contracts/contracts/hosted-site-domains";
import type { infer as zInfer } from "zod";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
) {
  let slug = original;
  const site = () => {
    return {
      siteId,
      publicSlug: slug,
      url: address(slug),
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
      return hostedSiteArtifactDetail(item, {
        siteId,
        slug,
        url: address(slug),
      });
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
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "public", revision: null });
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
  await within(menu).findByText("No verification yet");
  expect(
    within(menu).getByRole("heading", { name: "www.customer-example.net" }),
  ).toBeInTheDocument();
  expect(verifies).toBe(0);
  click(getNamedButton("Verify", menu));
  await within(menu).findByText("Domain verified. Save to use this address.");
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
    within(menu).findByRole("radio", {
      name: "www.customer-example.net HTTPS ready",
    }),
  ).resolves.toBeChecked();
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
    within(menu).findByRole("radio", {
      name: "pending.customer-example.net Finish setup",
    }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  expect(getNamedButton("Save", menu)).toBeDisabled();
  expect(within(menu).queryByRole("combobox")).not.toBeInTheDocument();
  click(getNamedButton("Manage pending.customer-example.net", menu));
  await within(menu).findByRole("heading", {
    name: "pending.customer-example.net",
  });
  expect(within(menu).getByText("No verification yet")).toBeInTheDocument();
  click(getNamedButton("Cancel", menu));
  await expect(
    within(menu).findByRole("radio", {
      name: "pending.customer-example.net Finish setup",
    }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
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
    within(menu).findByRole("radio", {
      name: "verified.customer-example.net HTTPS ready",
    }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  expect(getNamedButton("Save", menu)).toBeDisabled();
  expect(
    getNamedButton("Manage verified.customer-example.net", menu),
  ).toBeEnabled();
});

test("all five verification checks explain why three passed checks still cannot enable the domain", async () => {
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
    {
      type: "TXT" as const,
      name: `_acme-challenge.${hostname}`,
      value: "certificate-one",
    },
    {
      type: "TXT" as const,
      name: `_acme-challenge.${hostname}`,
      value: "certificate-two",
    },
  ];
  const passed = { status: "passed" as const, message: "Verified" };
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
        records,
        verification: {
          status: "incomplete",
          eligibleForSelection: false,
          checkedAt,
          validationRecords: records.slice(2),
          checks: {
            ownership: passed,
            dns: passed,
            certificate: passed,
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
              observedValues:
                index === 3 ? ["certificate-one"] : [record.value],
              status: index === 3 ? ("pending" as const) : ("passed" as const),
              message:
                index === 3
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
  await within(menu).findByText("Domain activation");
  expect(within(menu).getByText("Website routing")).toBeInTheDocument();
  expect(
    within(menu).getByText(
      "Your domain is still activating. Wait, then click Verify again.",
    ),
  ).toBeInTheDocument();
  expect(getNamedButton("Verify", menu)).toBeEnabled();
  expect(
    queryAllByRoleFast("button", menu).find((button) => {
      return button.textContent === "Save";
    }),
  ).toBeUndefined();
  expect(
    queryAllByRoleFast("button", menu).find((button) => {
      return (
        button.getAttribute("aria-label") === `Copy CNAME value ${hostname}`
      );
    }),
  ).toBeUndefined();
  const name = `_acme-challenge.${hostname}`;
  click(getNamedButton(`Copy TXT name ${name}`, menu));
  await waitFor(() => {
    return expect(clipboard.writes.at(-1)).toBe(name);
  });
  click(getNamedButton(`Copy TXT value ${name}`, menu));
  await waitFor(() => {
    return expect(clipboard.writes.at(-1)).toBe("certificate-two");
  });
  await expect(
    findNamedLink("Open Cloudflare DNS", menu),
  ).resolves.toHaveAttribute("href", "https://dash.cloudflare.com/");
  expect(
    queryAllByRoleFast("link", menu).find((link) => {
      return link.textContent?.includes("Configure website records");
    }),
  ).toBeUndefined();
});

test("a supported DNS setup opens provider consent without verifying or saving the hostname", async () => {
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
  const automaticUrl =
    "https://vercel.com/domain-connect/v2/domainTemplates/providers/okou.ai/services/hosted-site/apply?domain=customer-example.net&sig=test";
  const preview = await publishedReport(true, {
    providerName: "Vercel",
    controlPanelUrl: "https://vercel.com/domains",
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
  const link = await findNamedLink("Configure website records", menu);
  expect(link).toHaveAttribute("href", automaticUrl);
  expect(link).toHaveAttribute("target", "_blank");
  expect(
    within(menu).getByText(
      "This configures the website CNAME and ownership TXT. Add any extra certificate records below, then return here and click Verify.",
    ),
  ).toBeInTheDocument();
  expect(getNamedButton("Verify", menu)).toBeEnabled();
  expect(within(menu).getByText("No verification yet")).toBeInTheDocument();
});
