import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { createStore } from "ccstate";
import { escapeText } from "entities/escape";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { artifactAccessRoutes } from "../artifact-access";
import { integrationsSlackRoutes } from "../integrations-slack";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  createPublicSlackOrgApi,
  uniqueSlackUserId,
} from "./helpers/slack-public-install";
import { now } from "../../../lib/time";

const context = testContext();

const APP_ORIGIN = "https://app.okou.test";
const CHANNEL = "C_PREVIEW";
const MESSAGE_TS = "1710000000.000100";

interface UnfurlBlock {
  readonly type: string;
  readonly text?: { readonly type: string; readonly text: string };
  readonly image_url?: string;
  readonly alt_text?: string;
}

interface UnfurlRequest {
  readonly channel: string;
  readonly ts: string;
  readonly unfurls: Record<string, { readonly blocks: readonly UnfurlBlock[] }>;
}

async function installedWorkspace() {
  const fixture = await createPublicSlackOrgApi(context).installOrg();
  context.mocks.slack.chat.unfurl.mockResolvedValue({ ok: true });
  return fixture;
}

/** Shares links in one Slack message and returns every unfurl request. */
async function shareLinks(
  teamId: string,
  urls: readonly string[],
  user?: string,
): Promise<readonly UnfurlRequest[]> {
  // Settle installation notifications so only this delivery is observed.
  await flushWaitUntilForTest();
  const unfurl = context.mocks.slack.chat.unfurl;
  unfurl.mockClear();
  context.mocks.slack.createClient.mockClear();
  context.mocks.slack.chat.postMessage.mockClear();
  await createBddIntegrationApi(context).postSlackEvent(teamId, {
    type: "link_shared",
    channel: CHANNEL,
    message_ts: MESSAGE_TS,
    ...(user === undefined ? {} : { user }),
    links: urls.map((url) => {
      return { url, domain: new URL(url).hostname };
    }),
  });
  await flushWaitUntilForTest();
  return unfurl.mock.calls.map((call) => {
    return call[0] as UnfurlRequest;
  });
}

/** The Slack client token used by the most recent unfurl request. */
function unfurlToken(): unknown {
  const unfurlOrder = context.mocks.slack.chat.unfurl.mock.invocationCallOrder;
  const lastUnfurl = unfurlOrder[unfurlOrder.length - 1] ?? 0;
  const clients = context.mocks.slack.createClient.mock;
  let token: unknown;
  for (const [index, order] of clients.invocationCallOrder.entries()) {
    if (order < lastUnfurl) {
      token = clients.calls[index]?.[0];
    }
  }
  return token;
}

/** Serves an App or hosted page and counts its fetches. */
function servePage(
  url: string,
  html: string,
  init: { readonly status?: number; readonly contentType?: string } = {},
) {
  const fetches: Request[] = [];
  const target = new URL(url);
  server.use(
    http.get(`${target.origin}${target.pathname}`, ({ request }) => {
      fetches.push(request);
      return new HttpResponse(html, {
        status: init.status ?? 200,
        headers: {
          "content-type": init.contentType ?? "text/html; charset=utf-8",
        },
      });
    }),
  );
  return fetches;
}

function siteFile(path: string, content: string) {
  return {
    path,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType: "text/html; charset=utf-8",
  };
}

/** Publishes a public hosted site whose uploaded index.html has the title. */
async function publishPublicSite(owner: ApiTestUser, title: string) {
  const host = createHostBddApi(context);
  const storage = host.captureHostedSitesS3();
  const html = `<!doctype html><html><head><title>${escapeText(title)}</title></head><body></body></html>`;
  const prepared = await host.prepareHostedSite(owner, {
    site: `site-${randomUUID().slice(0, 8)}`,
    title,
    visibility: "public",
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [siteFile("/index.html", html)],
  });
  for (const key of storage.objects.keys()) {
    if (key.endsWith("/index.html")) {
      storage.objects.set(key, html);
    }
  }
  await host.completeHostedSite(owner, prepared.deploymentId);
  const aliasUrl = prepared.aliasUrl ?? prepared.url;
  const artifactUrl = prepared.artifactUrl ?? prepared.url;
  return { ...prepared, aliasUrl, artifactUrl };
}

/** The signed preview source inside a Cloudflare image transformation. */
function signedImageSource(imageUrl: string | undefined): URL {
  if (!imageUrl) {
    throw new Error("Expected a Cloudflare transformation");
  }
  const url = new URL(imageUrl);
  const [, cdn, image, directives, ...source] = url.pathname.split("/");
  if (
    url.origin !== "https://a.okou.io" ||
    cdn !== "cdn-cgi" ||
    image !== "image" ||
    !directives ||
    source.length === 0
  ) {
    throw new Error(`Expected a Cloudflare transformation: ${imageUrl}`);
  }
  return new URL(`${source.join("/")}${url.search}`);
}

function sectionTexts(blocks: readonly UnfurlBlock[]): string[] {
  return blocks
    .filter((block) => {
      return block.type === "section";
    })
    .map((block) => {
      return block.text?.text ?? "";
    });
}

function imageBlock(blocks: readonly UnfurlBlock[]): UnfurlBlock | undefined {
  return blocks.find((block) => {
    return block.type === "image";
  });
}

/** A Slack workspace with a connected peer and an Open Graph `/works` page. */
async function openGraphWorksPage() {
  const fixture = await installedWorkspace();
  const peer = await createPublicSlackOrgApi(context).connectMember({
    orgId: fixture.orgId,
    userId: `user_${randomUUID()}`,
    slackWorkspaceId: fixture.slackWorkspaceId,
  });
  const pageUrl = `${APP_ORIGIN}/works`;
  const fetches = servePage(
    pageUrl,
    '<!doctype html><html><head><meta property="og:title" content="Published title"><meta property="og:image" content="https://images.example.com/cover.png"></head><body></body></html>',
  );
  return { fixture, peer, pageUrl, fetches };
}

/** Shares the page once per author and summarizes each delivery's preview. */
async function openGraphPreviews(
  teamId: string,
  pageUrl: string,
  fetches: readonly Request[],
  authors: readonly (string | undefined)[],
) {
  const previews = [];
  for (const author of authors) {
    const requests = await shareLinks(teamId, [pageUrl], author);
    const blocks = requests[0]?.unfurls[pageUrl]?.blocks ?? [];
    const image = imageBlock(blocks);
    const source = signedImageSource(image?.image_url);
    previews.push({
      unfurlRequests: requests.length,
      firstBlock: blocks[0],
      sections: sectionTexts(blocks),
      altText: image?.alt_text,
      compact: image?.image_url?.includes("width=320,height=112"),
      imagePath: source.pathname,
      imageSource: source.searchParams.get("url"),
      signed: Boolean(source.searchParams.get("signature")),
      pageFetches: fetches.length,
    });
  }
  return previews;
}

function expectedOpenGraphPreview(pageUrl: string, pageFetches: number) {
  return {
    unfurlRequests: 1,
    firstBlock: { type: "divider" },
    sections: [`*<${pageUrl}|Published title>*`],
    altText: "Published title",
    compact: true,
    imagePath: "/api/artifact-og/slack.png",
    imageSource: "https://images.example.com/cover.png",
    signed: true,
    pageFetches,
  };
}

describe("Slack link previews", () => {
  it("slack-link-unfurl-019 verifies the webhook signature before acknowledging", async () => {
    const integrations = createBddIntegrationApi(context);
    integrations.configureSlackAppMocks();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T_UNKNOWN",
      event_id: `EvBDD${randomUUID().replace(/-/g, "")}`,
      event: {
        type: "link_shared",
        channel: CHANNEL,
        message_ts: MESSAGE_TS,
        links: [{ url: "https://alias.okou.app/", domain: "alias.okou.app" }],
      },
    });

    await integrations.requestSlackEvent(
      body,
      {
        "x-slack-request-timestamp": String(Math.floor(now() / 1000)),
        "x-slack-signature": "v0=invalid",
      },
      [401],
    );
    await integrations.postSlackEvent("T_UNKNOWN", {
      type: "link_shared",
      channel: CHANNEL,
      message_ts: MESSAGE_TS,
      links: [{ url: "https://alias.okou.app/", domain: "alias.okou.app" }],
    });
    await flushWaitUntilForTest();

    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
  });

  it("slack-link-unfurl-003 uses compact branding when anonymous App pages provide no Open Graph metadata", async () => {
    const fixture = await installedWorkspace();
    const chatPath = `/chat/${randomUUID()}`;
    const pages = [
      { url: `${APP_ORIGIN}/`, href: `${APP_ORIGIN}/` },
      { url: `${APP_ORIGIN}/works`, href: `${APP_ORIGIN}/works` },
      { url: `${APP_ORIGIN}/settings`, href: `${APP_ORIGIN}/settings` },
      {
        url: `${APP_ORIGIN}${chatPath}?view=full&tab=1#cover|v1`,
        href: `${APP_ORIGIN}${chatPath}?view=full&amp;tab=1#cover%7Cv1`,
      },
    ];
    const fetches = pages.map((page) => {
      return servePage(page.url, "<!doctype html><html><body></body></html>");
    });
    context.mocks.s3.send.mockClear();

    const requests = await shareLinks(
      fixture.slackWorkspaceId,
      pages.map((page) => {
        return page.url;
      }),
    );

    expect(requests).toHaveLength(1);
    for (const page of pages) {
      const blocks = requests[0]?.unfurls[page.url]?.blocks ?? [];
      expect(blocks[0]).toStrictEqual({ type: "divider" });
      expect(sectionTexts(blocks)).toStrictEqual([`*<${page.href}|Okou>*`]);
      const image = imageBlock(blocks);
      expect(image?.image_url).toContain("height=112");
      expect(image?.image_url).toContain("okou-og-image");
    }
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    for (const pageFetches of fetches) {
      expect(pageFetches).toHaveLength(1);
      expect(pageFetches[0]?.headers.get("authorization")).toBeNull();
      expect(pageFetches[0]?.headers.get("cookie")).toBeNull();
    }
  });

  it("slack-link-unfurl-010 leaves normal connections intact with old installation scopes", async () => {
    const bdd = createBddApi(context);
    const integrations = createBddIntegrationApi(context);
    integrations.configureSlackAppMocks();
    const admin = bdd.user({ orgRole: "org:admin" });
    const { teamId } = await integrations.installSlackWorkspace(admin, {
      botScopes:
        "app_mentions:read,channels:history,chat:write,commands,im:history,users:read",
    });
    context.mocks.slack.chat.unfurl.mockResolvedValue({ ok: true });
    const site = await publishPublicSite(admin, "Quarterly report");
    const worksFetches = servePage(
      `${APP_ORIGIN}/works`,
      "<title>Works</title>",
    );

    const requests = await shareLinks(teamId, [
      site.artifactUrl,
      `${APP_ORIGIN}/works`,
    ]);

    expect(requests).toStrictEqual([]);
    expect(worksFetches).toStrictEqual([]);
    createRouteMocks(context).clerk.session(
      admin.userId,
      admin.orgId,
      "org:admin",
    );
    const status = await accept(
      setupApp({ context, routes: integrationsSlackRoutes })(
        integrationsSlackContract,
      ).getStatus({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      scopeMismatch: true,
    });
    expect(status.body.reinstallUrl).toBeTruthy();
  });

  it("slack-link-unfurl-018 does not preview a deleted site", async () => {
    const fixture = await installedWorkspace();
    const site = await publishPublicSite(fixture.actor, "Retired report");
    await createHostBddApi(context).deleteHostedSite(
      fixture.actor,
      site.publicSlug,
    );
    const fetches = [
      servePage(site.artifactUrl, "<title>Retired</title>"),
      servePage(site.aliasUrl, "<title>Retired</title>"),
    ];

    const requests = await shareLinks(fixture.slackWorkspaceId, [
      site.artifactUrl,
      site.aliasUrl,
    ]);

    expect(requests).toStrictEqual([]);
    expect(fetches.flat()).toStrictEqual([]);
  });

  it("slack-link-unfurl-017 keeps public hosted artifact metadata instead of page Open Graph", async () => {
    const fixture = await installedWorkspace();
    const title = 'Report & <!channel> "标题"';
    const site = await publishPublicSite(fixture.actor, title);
    const pageHtml =
      '<meta property="og:title" content="Other title"><meta property="og:image" content="https://images.example.com/other.png">';
    const fetches = [
      servePage(site.artifactUrl, pageHtml),
      servePage(site.aliasUrl, pageHtml),
    ];
    const urls = [
      site.artifactUrl,
      site.aliasUrl,
      new URL("/index.html", site.aliasUrl).href,
    ];

    const requests = await shareLinks(fixture.slackWorkspaceId, urls);

    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]?.unfurls ?? {}).sort()).toStrictEqual(
      [...urls].sort(),
    );
    for (const url of urls) {
      const blocks = requests[0]?.unfurls[url]?.blocks ?? [];
      expect(sectionTexts(blocks)).toStrictEqual([
        `*<${new URL(url).href}|Report &amp; &lt;!channel&gt; "标题">*`,
      ]);
      expect(imageBlock(blocks)?.image_url).toContain(
        `/api/artifact-og/image?kind=host&id=${site.deploymentId}`,
      );
    }
    expect(fetches.flat()).toStrictEqual([]);
  });

  it("slack-link-unfurl-001 adds a divider, linked title and compact image for a public hosted site", async () => {
    const fixture = await installedWorkspace();
    const title = 'Report & <!channel> "标题"';
    const site = await publishPublicSite(fixture.actor, title);
    const fetches = [
      servePage(site.artifactUrl, "<title>Other</title>"),
      servePage(site.aliasUrl, "<title>Other</title>"),
    ];
    const artifactHref = new URL(site.artifactUrl).href;
    const immutable = `${artifactHref}?ref=slack#cover|v1`;
    const alias = new URL("/index.html", site.aliasUrl).href;

    const requests = await shareLinks(
      fixture.slackWorkspaceId,
      [immutable, alias, immutable],
      uniqueSlackUserId(),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.channel).toBe(CHANNEL);
    expect(requests[0]?.ts).toBe(MESSAGE_TS);
    expect(unfurlToken()).toBe(fixture.botToken);
    expect(Object.keys(requests[0]?.unfurls ?? {})).toStrictEqual([
      immutable,
      alias,
    ]);
    for (const [url, href] of [
      [immutable, `${artifactHref}?ref=slack#cover%7Cv1`],
      [alias, alias],
    ] as const) {
      const blocks = requests[0]?.unfurls[url]?.blocks ?? [];
      expect(blocks[0]).toStrictEqual({ type: "divider" });
      expect(sectionTexts(blocks)).toStrictEqual([
        `*<${href}|Report &amp; &lt;!channel&gt; "标题">*`,
      ]);
      const image = imageBlock(blocks);
      expect(image?.alt_text).toBe(title);
      expect(image?.image_url).toContain("width=320,height=112");
      expect(image?.image_url).toContain(
        `/api/artifact-og/image?kind=host&id=${site.deploymentId}`,
      );
    }
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(fetches.flat()).toStrictEqual([]);
  });

  it("slack-link-unfurl-002 (1/2) uses Open Graph for a connected peer and an unconnected sharer", async () => {
    const { fixture, peer, pageUrl, fetches } = await openGraphWorksPage();

    await expect(
      openGraphPreviews(fixture.slackWorkspaceId, pageUrl, fetches, [
        peer.slackUserId,
        uniqueSlackUserId(),
      ]),
    ).resolves.toStrictEqual([
      expectedOpenGraphPreview(pageUrl, 1),
      expectedOpenGraphPreview(pageUrl, 2),
    ]);
  });

  it("slack-link-unfurl-002 (2/2) uses Open Graph for an event without an author and for the installer", async () => {
    const { fixture, pageUrl, fetches } = await openGraphWorksPage();

    await expect(
      openGraphPreviews(fixture.slackWorkspaceId, pageUrl, fetches, [
        undefined,
        fixture.slackUserId,
      ]),
    ).resolves.toStrictEqual([
      expectedOpenGraphPreview(pageUrl, 1),
      expectedOpenGraphPreview(pageUrl, 2),
    ]);
  });

  it("slack-link-unfurl-004 reads Open Graph for non-artifact App, shared-thread and hosted subpages", async () => {
    const fixture = await installedWorkspace();
    const urls = [
      `${APP_ORIGIN}/works`,
      "https://launch-site.okou.app/guide/intro.html",
      `${APP_ORIGIN}/shared/${randomUUID()}`,
      `${APP_ORIGIN}/unknown-page`,
      "https://other-site.okou.app/notes/page.html",
    ];
    for (const url of urls) {
      servePage(
        url,
        '<!doctype html><html><head><base href="/assets/"><meta property="og:title" content="Launch &amp; &lt;!channel&gt; 计划"><meta property="og:description" content="Public &amp; reviewed &lt;!channel&gt;"><meta property="og:image" content="cover.png?x=1&amp;y=2"></head><body></body></html>',
      );
    }
    context.mocks.s3.send.mockClear();

    const requests = await shareLinks(fixture.slackWorkspaceId, urls);

    expect(requests).toHaveLength(1);
    for (const url of urls) {
      const blocks = requests[0]?.unfurls[url]?.blocks ?? [];
      expect(blocks[0]).toStrictEqual({ type: "divider" });
      expect(blocks[1]?.text?.text).toBe(
        `*<${url}|Launch &amp; &lt;!channel&gt; 计划>*`,
      );
      expect(blocks[2]?.text).toStrictEqual({
        type: "plain_text",
        text: "Public & reviewed <!channel>",
        emoji: false,
      });
      const imageUrl = imageBlock(blocks)?.image_url ?? "";
      expect(imageUrl).toContain("/api/artifact-og/slack.png");
      const source = signedImageSource(imageUrl);
      expect(source.searchParams.get("url")).toBe(
        `${new URL(url).origin}/assets/cover.png?x=1&y=2`,
      );
      expect(source.searchParams.get("signature")).toBeTruthy();
    }
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("slack-link-unfurl-007 skips failed, non-HTML and oversized pages without losing valid sibling previews", async () => {
    const fixture = await installedWorkspace();
    const works = `${APP_ORIGIN}/works`;
    servePage(works, '<meta property="og:title" content="Published title">');
    const missing = `${APP_ORIGIN}/missing-page`;
    servePage(missing, "Not found", { status: 404, contentType: "text/plain" });
    const sharedMissing = `${APP_ORIGIN}/shared/${randomUUID()}`;
    servePage(sharedMissing, "<title>Missing</title>", { status: 404 });
    const forbidden = `${APP_ORIGIN}/forbidden-page`;
    servePage(forbidden, "<title>Forbidden</title>", { status: 403 });
    const offline = `${APP_ORIGIN}/offline-page`;
    server.use(
      http.get(offline, () => {
        return HttpResponse.error();
      }),
    );
    const json = `${APP_ORIGIN}/data-page`;
    servePage(json, '{"title":"Data"}', { contentType: "application/json" });
    const oversized = `${APP_ORIGIN}/oversized-page`;
    servePage(
      oversized,
      `<meta property="og:title" content="Too large">${" ".repeat(4 * 1024 * 1024 + 1)}`,
    );

    const requests = await shareLinks(fixture.slackWorkspaceId, [
      missing,
      sharedMissing,
      forbidden,
      offline,
      json,
      oversized,
      works,
    ]);

    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]?.unfurls ?? {})).toStrictEqual([works]);
  });

  it("slack-link-unfurl-011 preserves sharing for report.png with none page metadata", async () => {
    const fixture = await installedWorkspace();
    await createStore().set(
      seedOrgMembership$,
      {
        orgId: fixture.orgId,
        userId: fixture.actor.userId,
        role: "admin",
        name: "Slack unfurl workspace",
      },
      context.signal,
    );
    const stored = createHostBddApi(context).captureHostedSitesS3();
    const baseS3 = context.mocks.s3.send.getMockImplementation();
    if (!baseS3) {
      throw new Error("Expected captured hosted-site S3 storage");
    }
    const pngBytes = Buffer.from("fake-png-bytes");
    context.mocks.s3.send.mockImplementation((operation, ...rest) => {
      const key =
        operation instanceof HeadObjectCommand ||
        operation instanceof GetObjectCommand
          ? operation.input.Key
          : undefined;
      if (
        operation instanceof HeadObjectCommand &&
        key?.startsWith("private-artifacts/")
      ) {
        return Promise.resolve({
          ContentLength: pngBytes.byteLength,
          ContentType: "image/png",
          Metadata: { "artifact-id": key.split("/")[1] },
        });
      }
      if (
        operation instanceof GetObjectCommand &&
        key?.startsWith("artifact-shares/") &&
        !stored.objects.has(key)
      ) {
        return Promise.reject(
          Object.assign(new Error("Missing publication policy"), {
            name: "NoSuchKey",
          }),
        );
      }
      if (
        operation instanceof GetObjectCommand &&
        key?.startsWith("private-artifacts/") &&
        !stored.objects.has(key)
      ) {
        return Promise.resolve({
          Body: Readable.from([pngBytes]),
          ContentLength: pngBytes.byteLength,
          ContentType: "image/png",
        });
      }
      return baseS3(operation, ...rest);
    });

    const authHeaders = Object.freeze({
      authorization: "Bearer clerk-session",
    });
    createRouteMocks(context).clerk.session(
      fixture.actor.userId,
      fixture.orgId,
      "org:admin",
    );
    const artifactApp = setupApp({
      context,
      routes: [
        ...uploadsPrepareRoutes,
        ...uploadsCompleteRoutes,
        ...artifactAccessRoutes,
      ],
    });
    const prepared = await accept(
      artifactApp(uploadsContract).prepare({
        headers: authHeaders,
        body: {
          filename: "report.png",
          contentType: "image/png",
          size: pngBytes.byteLength,
          purpose: "artifact",
        },
      }),
      [200],
    );
    const completed = await accept(
      artifactApp(uploadsContract).complete({
        headers: authHeaders,
        body: { id: prepared.body.id },
      }),
      [200],
    );

    const privateUrl = new URL(completed.body.url, APP_ORIGIN).href;
    const queryAndFragmentUrl = `${privateUrl}?ref=slack#page=1`;
    const referenceUrl = new URL(
      artifactReferencePath(prepared.body.id),
      APP_ORIGIN,
    ).href;
    const missingReferenceUrl = new URL(
      artifactReferencePath(randomUUID(), "missing.png"),
      APP_ORIGIN,
    ).href;
    const pageFetches: Request[] = [];
    server.use(
      http.get(`${APP_ORIGIN}/artifacts/:reference`, ({ request }) => {
        pageFetches.push(request);
        return new HttpResponse("<!doctype html><html><body></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    );

    await expect(
      shareLinks(fixture.slackWorkspaceId, [
        privateUrl,
        queryAndFragmentUrl,
        referenceUrl,
        missingReferenceUrl,
      ]),
    ).resolves.toStrictEqual([]);
    expect(pageFetches).toStrictEqual([]);

    createRouteMocks(context).clerk.session(
      fixture.actor.userId,
      fixture.orgId,
      "org:admin",
    );
    const orgShared = await accept(
      artifactApp(artifactAccessContract).updateVisibility({
        headers: authHeaders,
        params: { artifactId: prepared.body.id },
        body: { visibility: "organization" },
      }),
      [200],
    );
    const shortUrl = orgShared.body.shortUrl;
    if (!shortUrl) {
      throw new Error("Expected shortUrl for organization-shared file");
    }

    await expect(
      shareLinks(fixture.slackWorkspaceId, [
        privateUrl,
        queryAndFragmentUrl,
        referenceUrl,
        shortUrl,
        missingReferenceUrl,
      ]),
    ).resolves.toStrictEqual([]);
    expect(pageFetches).toStrictEqual([]);

    createRouteMocks(context).clerk.session(
      fixture.actor.userId,
      fixture.orgId,
      "org:admin",
    );
    const published = await accept(
      artifactApp(artifactAccessContract).updateVisibility({
        headers: authHeaders,
        params: { artifactId: prepared.body.id },
        body: { visibility: "public" },
      }),
      [200],
    );

    const knownUrls = [
      ...new Set([
        privateUrl,
        queryAndFragmentUrl,
        referenceUrl,
        shortUrl,
        ...(published.body.shortUrl ? [published.body.shortUrl] : []),
      ]),
    ];
    const publishedRequests = await shareLinks(fixture.slackWorkspaceId, [
      ...knownUrls,
      missingReferenceUrl,
    ]);
    expect(publishedRequests).toHaveLength(1);
    expect(Object.keys(publishedRequests[0]?.unfurls ?? {})).toStrictEqual(
      knownUrls,
    );
    for (const url of knownUrls) {
      const blocks = publishedRequests[0]?.unfurls[url]?.blocks ?? [];
      const image = imageBlock(blocks);
      expect(image?.alt_text).toBe("report.png");
      expect(image?.image_url).toContain(
        "/api/artifact-og/image?kind=reference",
      );
    }

    createRouteMocks(context).clerk.session(
      fixture.actor.userId,
      fixture.orgId,
      "org:admin",
    );
    await accept(
      artifactApp(artifactAccessContract).updateVisibility({
        headers: authHeaders,
        params: { artifactId: prepared.body.id },
        body: { visibility: "private" },
      }),
      [200],
    );

    await expect(
      shareLinks(fixture.slackWorkspaceId, knownUrls),
    ).resolves.toStrictEqual([]);
    expect(pageFetches).toStrictEqual([]);
  });
});
