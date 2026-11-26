import { randomUUID } from "node:crypto";

import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { escapeAttribute } from "entities/escape";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactOgRoutes } from "../artifact-og";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";

const context = testContext();

const APP_ORIGIN = "https://app.okou.test";

/** Installs the Slack bot with its default link scopes for a new workspace. */
async function installedWorkspace(): Promise<string> {
  const fixture = await createPublicSlackOrgApi(context).installOrg();
  context.mocks.slack.chat.unfurl.mockResolvedValue({ ok: true });
  return fixture.slackWorkspaceId;
}

/** An App page whose Open Graph image is the given URL. */
function appPageWithImage(imageUrl: string): string {
  const pageUrl = `${APP_ORIGIN}/pages/${randomUUID()}`;
  const escaped = escapeAttribute(imageUrl);
  server.use(
    http.get(pageUrl, () => {
      return new HttpResponse(
        `<!doctype html><html><head><title>Preview page</title><meta property="og:image" content="${escaped}"></head><body></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }),
  );
  return pageUrl;
}

/** Shares links in Slack and returns the image URL unfurled for each link. */
async function unfurlImages(
  workspaceId: string,
  pageUrls: readonly string[],
): Promise<Record<string, string | null>> {
  const unfurl = context.mocks.slack.chat.unfurl;
  unfurl.mockClear();
  await createBddIntegrationApi(context).postSlackEvent(workspaceId, {
    type: "link_shared",
    channel: "C_PREVIEW",
    message_ts: "1710000000.000100",
    links: pageUrls.map((url) => {
      return { url, domain: "app.okou.test" };
    }),
  });
  await flushWaitUntilForTest();
  // A link whose preview omits the image block maps to null.
  const images: Record<string, string | null> = {};
  for (const call of unfurl.mock.calls) {
    const request = call[0] as {
      readonly unfurls: Record<
        string,
        { readonly blocks: readonly { type: string; image_url?: string }[] }
      >;
    };
    for (const [url, preview] of Object.entries(request.unfurls)) {
      const image = preview.blocks.find((block) => {
        return block.type === "image";
      });
      images[url] = image?.image_url ?? null;
    }
  }
  return images;
}

function slackImageClient() {
  return setupApp({ context, routes: artifactOgRoutes })(artifactOgContract);
}

/** Splits the public-artifacts Cloudflare transformation of an image URL. */
function cloudflareTransformation(imageUrl: string): {
  readonly directives: string;
  readonly source: URL;
} {
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
  return {
    directives,
    source: new URL(`${source.join("/")}${url.search}`),
  };
}

describe("Slack preview image URLs", () => {
  it("slack-preview-image-002 keeps first-party file previews on the policy-gated thumbnail URL", async () => {
    const workspaceId = await installedWorkspace();
    const pageUrl = appPageWithImage("https://a.okou.io/0123456789.png");

    const images = await unfurlImages(workspaceId, [pageUrl]);

    const image = new URL(images[pageUrl] ?? "missing:");
    expect(`${image.origin}${image.pathname}`).toBe(
      "https://a.okou.io/0123456789.png",
    );
    expect(Object.fromEntries(image.searchParams)).toStrictEqual({
      thumbnail: "1",
      width: "320",
      height: "112",
      fit: "scale-down",
      quality: "85",
    });
  });

  it("slack-preview-image-001 redirects the signed preview source to the literal original image", async () => {
    const workspaceId = await installedWorkspace();
    const original =
      "https://images.example.com/original?token=a%2Fb%2Bc&size=large";
    const pageUrl = appPageWithImage(original);

    const images = await unfurlImages(workspaceId, [pageUrl]);
    const imageUrl = images[pageUrl] ?? "";

    expect(imageUrl.length).toBeGreaterThan(0);
    expect(imageUrl.length).toBeLessThanOrEqual(3000);
    const { directives, source } = cloudflareTransformation(imageUrl);
    expect(directives).toMatch(/^width=320,height=112,/u);
    expect(`${source.origin}${source.pathname}`).toBe(
      "https://api.okou.test/api/artifact-og/slack.png",
    );
    expect(source.searchParams.get("url")).toBe(original);
    const response = await accept(
      slackImageClient().slackImage({
        query: {
          url: source.searchParams.get("url") ?? "",
          signature: source.searchParams.get("signature") ?? "",
        },
      }),
      [302],
    );
    expect(response.headers.get("location")).toBe(original);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("slack-preview-image-006 rejects modified capabilities and refuses nested or unbounded image sources", async () => {
    const workspaceId = await installedWorkspace();
    const issuedPage = appPageWithImage("https://images.example.com/cover.png");
    const issued = await unfurlImages(workspaceId, [issuedPage]);
    const issuedImage = issued[issuedPage] ?? "";
    const capability = cloudflareTransformation(issuedImage).source;
    const url = capability.searchParams.get("url") ?? "";
    const signature = capability.searchParams.get("signature") ?? "";
    const otherSignature = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;

    const [changedUrl, changedSignature] = await Promise.all([
      accept(
        slackImageClient().slackImage({
          query: { url: "https://images.example.com/other.png", signature },
        }),
        [403],
      ),
      accept(
        slackImageClient().slackImage({
          query: { url, signature: otherSignature },
        }),
        [403],
      ),
    ]);
    const rejectedPages = [
      appPageWithImage(capability.href),
      appPageWithImage(
        `https://a.okou.io/cdn-cgi/image/width=640/${issuedImage}`,
      ),
      appPageWithImage(`https://images.example.com/${"a".repeat(2049)}.png`),
      appPageWithImage("https://images.example.com:8443/cover.png"),
      appPageWithImage(`${APP_ORIGIN}/artifacts/cover.png`),
    ];
    const images = await unfurlImages(workspaceId, rejectedPages);

    expect(changedUrl.status).toBe(403);
    expect(changedSignature.status).toBe(403);
    expect(
      rejectedPages.map((page) => {
        return images[page];
      }),
    ).toStrictEqual([null, null, null, null, null]);
  });
});
