import {
  hostContract,
  type HostedSiteFilesResponse,
} from "@okouai/api-contracts/contracts/host";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor } from "@testing-library/react";
import { strToU8, unzipSync } from "fflate";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

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
  deliveryUrl = DEPLOYMENT_URL,
  artifactUrl = deliveryUrl,
  manifestUrl = sourceUrl,
  members = publicationMembers(),
}: {
  readonly sourceUrl?: string;
  readonly deliveryUrl?: string;
  readonly artifactUrl?: string | null;
  readonly manifestUrl?: string;
  readonly members?: ReturnType<typeof publicationMembers>;
} = {}): void {
  mockAttachmentChat(context, {
    chatEvents: [siteMessage(sourceUrl)],
    artifacts: [
      artifactFile("launch-site.html", {
        contentType: "text/html",
        url: sourceUrl,
        artifactKind: "hosted-site",
      }),
    ],
  });
  const source = new URL(sourceUrl);
  const publication: HostedSiteFilesResponse = {
    siteId: SITE_ID,
    deploymentId: DEPLOYMENT_ID,
    publicSlug: "launch-site",
    url: manifestUrl,
    ...(artifactUrl ? { artifactUrl } : {}),
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
    if (
      params.publicSlug !== source.hostname.split(".")[0] ||
      query.hostname !== source.hostname
    ) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Hosted site not found" },
      });
    }
    return respond(200, publication);
  });
  for (const member of members) {
    context.mocks.http.get(new URL(member.path, deliveryUrl).href, () => {
      return HttpResponse.arrayBuffer(new Uint8Array(member.bytes).buffer);
    });
  }
  context.mocks.http.get(`${source.origin}${source.pathname}`, () => {
    return HttpResponse.text(PAGE);
  });
  if (source.origin !== new URL(deliveryUrl).origin) {
    // The alias has been redeployed after listing the older publication.
    context.mocks.http.get(`${source.origin}/index.html`, () => {
      return HttpResponse.text("<!doctype html><h1>New publication</h1>");
    });
  }
}

async function downloadSite(host = "app.okou.ai"): Promise<void> {
  await setupPage({ context, host, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("Launch site"));
  const dialog = await screen.findByRole("dialog");
  click(await findNamedButton("Download options", dialog));
  click(await findNamedMenuItem("Download"));
}

test.each([
  { name: "public alias", sourceUrl: SITE_URL, deliveryUrl: DEPLOYMENT_URL },
  {
    name: "SPA route",
    sourceUrl: `${SITE_URL}dashboard?tab=summary#chart`,
    deliveryUrl: DEPLOYMENT_URL,
  },
  {
    name: "legacy HTML link",
    sourceUrl: "https://launch-site.sites.vm0.io/index.html?preview=1#hero",
    deliveryUrl: DEPLOYMENT_URL,
  },
  {
    name: "immutable deployment",
    sourceUrl: DEPLOYMENT_URL,
    deliveryUrl: DEPLOYMENT_URL,
  },
  {
    name: "preview alias",
    sourceUrl: "https://launch-site.sites.vm7.io/",
    deliveryUrl: `https://dpl-${DEPLOYMENT_ID}.sites.vm7.io/`,
    host: "localhost",
  },
  {
    name: "alias without immutable URL metadata",
    sourceUrl: SITE_URL,
    deliveryUrl: SITE_URL,
    artifactUrl: null,
  },
  {
    name: "shared alias with an owner reference",
    sourceUrl: SITE_URL,
    deliveryUrl: SITE_URL,
    artifactUrl: artifactReferencePath(DEPLOYMENT_ID, "index.html"),
    manifestUrl: artifactReferencePath(DEPLOYMENT_ID, "index.html"),
  },
])("a $name downloads every published member as a zip", async (publication) => {
  mockPublicPublication(publication);
  const browser = context.mocks.browser.blobDownload();

  await downloadSite(publication.host);

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
});

test("a public site containing one page downloads that HTML file", async () => {
  mockPublicPublication({ members: publicationMembers().slice(0, 1) });
  const browser = context.mocks.browser.blobDownload();

  await downloadSite();

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.filename).toBe("launch-site.html");
  await expect(browser.downloads[0]?.blob?.text()).resolves.toBe(PAGE);
});

test.each(["listing", "member"])(
  "a public site's unreadable %s reports failure without a partial download",
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

test.each([403, 404] as const)(
  "a public page remains downloadable when its publication listing returns %s",
  async (status) => {
    mockPublicPublication();
    context.mocks.api(hostContract.files, ({ respond }) => {
      return respond(status, {
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
  },
);

test.each(["/assets/cat.png", "/image", "/image/", "/%69mage"])(
  "a direct %s URL downloads only that image",
  async (path) => {
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
            path: path === "/assets/cat.png" ? path : "/image",
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
