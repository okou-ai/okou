import {
  hostContract,
  type HostedSiteFilesResponse,
} from "@okouai/api-contracts/contracts/host";
import { screen, waitFor } from "@testing-library/react";
import { strToU8, unzipSync } from "fflate";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  mockAttachmentChat,
  type AttachmentChatEvent,
} from "./chat-attachment-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000041";
const SITE_ID = "00000000-0000-4000-8000-000000000042";
const SITE_URL = "https://launch-site.okou.app/";
const DEPLOYMENT_URL = `https://dpl-${DEPLOYMENT_ID}.okou.app/`;
const PAGE =
  '<!doctype html><link rel="stylesheet" href="/assets/site.css"><img src="/assets/cat.png">';

function publicationMembers() {
  return [
    { path: "/index.html", contentType: "text/html", bytes: strToU8(PAGE) },
    {
      path: "/assets/site.css",
      contentType: "text/css",
      bytes: strToU8("body { color: teal }"),
    },
    {
      path: "/assets/cat.png",
      contentType: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff]),
    },
  ];
}

function siteMessage(url: string): AttachmentChatEvent {
  return {
    id: "site-download-message",
    role: "assistant",
    content: `[Launch site](${url})`,
    runId: ATTACHMENT_RUN_ID,
    runEventId: "site-download-event",
    sequenceNumber: 1,
    createdAt: "2026-03-10T00:00:01Z",
  };
}

function mockPublicPublication({
  sourceUrl = SITE_URL,
  members = publicationMembers(),
  artifactKind = "hosted-site",
}: {
  readonly sourceUrl?: string;
  readonly members?: ReturnType<typeof publicationMembers>;
  readonly artifactKind?: "hosted-site" | "presentation-html";
} = {}): void {
  mockAttachmentChat(context, {
    chatEvents: [siteMessage(sourceUrl)],
    artifacts: [
      artifactFile("launch-site.html", {
        title: "Quarterly launch report",
        contentType: "text/html",
        url: sourceUrl,
        artifactKind,
      }),
    ],
  });
  const source = new URL(sourceUrl);
  const publication: HostedSiteFilesResponse = {
    siteId: SITE_ID,
    deploymentId: DEPLOYMENT_ID,
    publicSlug: "launch-site",
    url: sourceUrl,
    artifactUrl: DEPLOYMENT_URL,
    fileCount: members.length,
    size: members.reduce((total, member) => {
      return total + member.bytes.length;
    }, 0),
    files: members.map((member) => {
      return {
        path: member.path,
        contentType: member.contentType,
        size: member.bytes.length,
        sha256: "a".repeat(64),
        downloadUrl: `https://storage.example.test/signed${member.path}`,
      };
    }),
  };
  context.mocks.api(hostContract.files, ({ params, query, respond }) => {
    expect(params.publicSlug).toBe("launch-site");
    expect(query.hostname).toBe(source.hostname);
    return respond(200, publication);
  });
  for (const member of members) {
    context.mocks.http.get(new URL(member.path, DEPLOYMENT_URL).href, () => {
      return HttpResponse.arrayBuffer(new Uint8Array(member.bytes).buffer);
    });
  }
  context.mocks.http.get(`${source.origin}${source.pathname}`, () => {
    return HttpResponse.text(PAGE);
  });
  // The alias has been redeployed after listing the published version.
  context.mocks.http.get(`${source.origin}/index.html`, () => {
    return HttpResponse.text("<!doctype html><h1>New publication</h1>");
  });
}

async function downloadSite(): Promise<void> {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
  });
  click(await findNamedLink("Launch site"));
  const dialog = await screen.findByRole("dialog");
  click(await findNamedButton("Download options", dialog));
  click(await findNamedMenuItem("Download"));
}

test.each([
  { name: "public alias", sourceUrl: SITE_URL },
  { name: "SPA route", sourceUrl: `${SITE_URL}dashboard?tab=summary#chart` },
])(
  "A $name link downloads every published member as a ZIP",
  async ({ sourceUrl }) => {
    mockPublicPublication({ sourceUrl });
    const browser = context.mocks.browser.blobDownload({ deferRead: true });

    await downloadSite();

    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    const download = browser.downloads[0];
    expect(download?.filename).toBe("launch-site.zip");
    expect(download?.blob?.type).toBe("application/zip");
    const archive = await download?.blob?.arrayBuffer();
    const unpacked = unzipSync(new Uint8Array(archive!));
    expect(Object.keys(unpacked).sort()).toStrictEqual([
      "assets/cat.png",
      "assets/site.css",
      "index.html",
    ]);
    for (const member of publicationMembers()) {
      expect(unpacked[member.path.slice(1)]).toStrictEqual(member.bytes);
    }
  },
);

test.each([
  { artifactKind: "hosted-site", productType: "website" },
  { artifactKind: "presentation-html", productType: "presentation" },
] as const)(
  "A $artifactKind link keeps its HTML filename and reports its product type",
  async ({ artifactKind, productType }) => {
    const telemetry = context.mocks.posthog();
    mockPublicPublication({
      members: publicationMembers().slice(0, 1),
      artifactKind,
    });
    const browser = context.mocks.browser.blobDownload({ deferRead: true });

    await downloadSite();

    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]?.filename).toBe("launch-site.html");
    await expect(browser.downloads[0]?.blob?.text()).resolves.toBe(PAGE);
    expect(screen.getByText("Quarterly launch report")).toBeInTheDocument();
    expect(
      telemetry.events.filter((event) => {
        return event.name === "artifact_action_clicked";
      }),
    ).toMatchObject([
      {
        name: "artifact_action_clicked",
        properties: { action: "download", artifact_type: productType },
      },
    ]);
  },
);

test.each(["listing", "member"])(
  "An unreadable public site %s reports failure without a partial download",
  async (failure) => {
    mockPublicPublication();
    if (failure === "listing") {
      context.mocks.api(hostContract.files, ({ respond }) => {
        return respond(500, {
          error: { code: "INTERNAL", message: "Listing unavailable" },
        });
      });
    } else {
      context.mocks.http.get(`${DEPLOYMENT_URL}assets/site.css`, () => {
        return new HttpResponse(null, { status: 404 });
      });
    }
    const browser = context.mocks.browser.blobDownload();

    await downloadSite();

    await expect(
      screen.findByText("Download failed"),
    ).resolves.toBeInTheDocument();
    expect(browser.downloads).toStrictEqual([]);
  },
);

test("A public page stays downloadable when its publication listing returns 404", async () => {
  mockPublicPublication();
  context.mocks.api(hostContract.files, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Publication unavailable" },
    });
  });
  const browser = context.mocks.browser.blobDownload();

  await downloadSite();

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.filename).toBe("launch-site.html");
  await expect(browser.downloads[0]?.blob?.text()).resolves.toBe(PAGE);
});

test.each([
  { path: "/assets/cat.png", listedPath: "/assets/cat.png" },
  { path: "/image/", listedPath: "/image" },
])(
  "A direct $path URL downloads only that image",
  async ({ path, listedPath }) => {
    const imageUrl = new URL(path, SITE_URL).href;
    const imageBytes = publicationMembers()[2]!.bytes;
    mockAttachmentChat(context, {
      chatEvents: [siteMessage(imageUrl)],
      artifacts: [
        artifactFile("cat.png", { url: imageUrl, contentType: "image/png" }),
      ],
    });
    context.mocks.http.get(imageUrl, () => {
      return HttpResponse.arrayBuffer(new Uint8Array(imageBytes).buffer);
    });
    context.mocks.api(hostContract.files, ({ respond }) => {
      return respond(200, {
        siteId: SITE_ID,
        deploymentId: DEPLOYMENT_ID,
        publicSlug: "launch-site",
        url: SITE_URL,
        fileCount: 2,
        size: PAGE.length + imageBytes.length,
        files: [
          { path: "/index.html", contentType: "text/html", size: PAGE.length },
          {
            path: listedPath,
            contentType: "image/png",
            size: imageBytes.length,
          },
        ].map((member) => {
          return {
            ...member,
            sha256: "a".repeat(64),
            downloadUrl: `https://storage.example.test/signed${member.path}`,
          };
        }),
      });
    });
    const browser = context.mocks.browser.blobDownload();

    await downloadSite();

    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]?.filename).toBe("cat.png");
    const bytes = await browser.downloads[0]?.blob?.arrayBuffer();
    expect(new Uint8Array(bytes!)).toStrictEqual(imageBytes);
  },
);
