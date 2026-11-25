import { test, expect } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { unzipSync, strFromU8 } from "fflate";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { conversation, assistantRow } from "./attachment-preview-boundaries.ts";
import {
  artifactFile,
  findNamedMenuItem,
  findNamedButton,
  findNamedLink,
  getNamedButton,
} from "./chat-attachment-test-helpers.ts";
import {
  publication,
  servePublication,
  entryHtml,
  stylesheet,
  catPng,
} from "./hosted-download-boundaries.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { type hostedDomainSettingsSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
import { type infer as zInfer } from "zod";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import userEvent from "@testing-library/user-event";
import {
  artifactSummary,
  artifactRun,
  hostedSiteArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import { openResources } from "./chat-resources-test-helpers.ts";

const context = testContext();

async function downloadFromLink(
  path: string,
  kind?: "presentation-html" | "hosted-site",
  image = false,
) {
  const url = new URL(path, publication).href;
  const title = "Quarterly launch report";
  const name = image ? "cat.png" : "launch-site.html";
  const label = image ? "View field photo" : "View publication";
  await conversation(context, {
    chatEvents: [assistantRow("[" + label + "](" + url + ")")],
    artifacts: [
      artifactFile(name, {
        url,
        title: kind ? title : undefined,
        artifactKind: kind,
        contentType: image ? "image/png" : "text/html",
      }),
    ],
  });
  click(await findAction("link", label));
  const panel = await screen.findByTestId("artifact-sidebar");
  click(await findAction("button", "Download artifact", panel));
  click(await findNamedMenuItem("Download"));
  return panel;
}
test.each([
  ["chat-hosted-site-download-001", "/"],
  ["chat-hosted-site-download-002", "/notes/spring?locale=en#results"],
] as const)(
  "%s saves the complete published directory from its chat link",
  async (_id, path) => {
    const browser = context.mocks.browser.blobDownload();
    servePublication(context);
    await downloadFromLink(path);
    await waitFor(() => {
      return expect(browser.downloads[0]?.filename).toBe("launch-site.zip");
    });
    const zip = unzipSync(
      new Uint8Array(await browser.downloads[0]!.blob!.arrayBuffer()),
    );
    expect(Object.keys(zip).sort()).toStrictEqual([
      "assets/cat.png",
      "assets/site.css",
      "index.html",
    ]);
    expect(strFromU8(zip["index.html"]!)).toBe(entryHtml);
    expect(strFromU8(zip["assets/site.css"]!)).toBe(stylesheet);
    expect(Array.from(zip["assets/cat.png"]!)).toStrictEqual(
      Array.from(catPng),
    );
  },
);
test.each([
  ["chat-hosted-site-download-008", "hosted-site", "website"],
  ["chat-hosted-site-download-009", "presentation-html", "presentation"],
] as const)(
  "%s preserves the title, HTML and product classification",
  async (_id, kind, product) => {
    const browser = context.mocks.browser.blobDownload(),
      analytics = context.mocks.posthog();
    servePublication(context, "single");
    const panel = await downloadFromLink("/", kind);
    expect(panel).toHaveTextContent("Quarterly launch report");
    await waitFor(() => {
      return expect(browser.downloads[0]?.filename).toBe("launch-site.html");
    });
    await expect(browser.downloads[0]!.blob!.text()).resolves.toBe(entryHtml);
    expect(analytics.events).toContainEqual(
      expect.objectContaining({
        name: "artifact_action_clicked",
        properties: {
          action: "download",
          surface: "page",
          artifact_type: product,
        },
      }),
    );
  },
);
test.each([
  ["chat-hosted-site-download-010", "server-error"],
  ["chat-hosted-site-download-011", "broken-css"],
] as const)(
  "%s reports a failed publication without saving a partial file",
  async (_id, failure) => {
    const browser = context.mocks.browser.blobDownload();
    servePublication(context, failure);
    await downloadFromLink("/");
    await expect(
      screen.findByText("Download failed"),
    ).resolves.toBeInTheDocument();
    expect(browser.downloads).toStrictEqual([]);
  },
);
test("chat-hosted-site-download-013 the public page remains downloadable after its manifest returns not found", async () => {
  const browser = context.mocks.browser.blobDownload();
  servePublication(context, "missing");
  await downloadFromLink("/");
  await waitFor(() => {
    return expect(browser.downloads[0]?.filename).toBe("launch-site.html");
  });
  await expect(browser.downloads[0]!.blob!.text()).resolves.toBe(entryHtml);
});
test.each([
  ["chat-hosted-site-download-014", "/assets/cat.png", "directory"],
  ["chat-hosted-site-download-016", "/image/", "image-route"],
] as const)(
  "%s saves the requested image bytes alone",
  async (_id, path, mode) => {
    const browser = context.mocks.browser.blobDownload();
    servePublication(context, mode);
    await downloadFromLink(path, undefined, true);
    await waitFor(() => {
      return expect(
        browser.downloads.map((d) => {
          return d.filename;
        }),
      ).toStrictEqual(["cat.png"]);
    });
    expect(
      new Uint8Array(await browser.downloads[0]!.blob!.arrayBuffer()),
    ).toStrictEqual(catPng);
  },
);

const title = "Quarterly launch report";
const original = "launch-recap";
const address = (slug: string) => {
  return "https://" + slug + ".okou.app";
};
const deployment = address("dpl-8a4d4487-18c0-44cd-a09d-206056d499b0");
const siteId = "be311386-caaa-4bfb-a74a-7d694c27c41e";
async function publishedReport(customDomains = false) {
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
