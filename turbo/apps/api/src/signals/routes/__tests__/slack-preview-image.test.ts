import { createHmac, randomUUID } from "node:crypto";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { escapeAttribute } from "entities/escape";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { array, object, record, string } from "zod";
import {
  setupAppWithRoutes,
  setupRawAppRequestWithRoutes,
} from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactOgRoutes } from "../artifact-og";
import { slackEventsRoutes } from "../slack-events";
import { createBddApi } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const imageClient = setupAppWithRoutes({ context, routes: artifactOgRoutes })(
  artifactOgContract,
);
const authorSlackUserId = "U_THUMBNAIL_SHARER";

async function fixture() {
  integrations.configureSlackAppMocks();
  const user = createBddApi(context).user({ orgRole: "org:admin" });
  if (!user.orgId) {
    throw new Error("Expected an organization");
  }
  const actor = { ...user, orgId: user.orgId };
  const { teamId } = await integrations.installSlackWorkspace(actor, {
    botScopes: "chat:write,im:write,users:read,links:read,links:write",
    installerSlackUserId: authorSlackUserId,
  });
  await flushWaitUntilForTest();
  context.mocks.slack.chat.unfurl.mockResolvedValue({ ok: true });
  return { teamId };
}

/** Obtain capabilities through a real signed webhook, without signing test URLs. */
async function previewUrls(teamId: string, sources: readonly string[]) {
  const pages = sources.map((source, index) => {
    const url = new URL(`/thumbnail-test/${index}`, env("APP_URL")).href;
    server.use(
      http.get(url, () => {
        return HttpResponse.html(
          `<head><meta property="og:title" content="Published title"><meta property="og:image" content="${escapeAttribute(source)}"></head>`,
        );
      }),
    );
    return url;
  });
  const body = JSON.stringify({
    type: "event_callback",
    team_id: teamId,
    event_id: `Ev_${randomUUID()}`,
    event: {
      type: "link_shared",
      channel: "C_PREVIEW",
      user: authorSlackUserId,
      message_ts: "1791618140.315329",
      links: pages.map((url) => {
        return { url };
      }),
    },
  });
  context.mocks.slack.chat.unfurl.mockClear();
  await accept(
    setupRawAppRequestWithRoutes({ context, routes: slackEventsRoutes })(
      "/api/webhooks/slack/events",
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          ...integrations.signedSlackIngressHeaders(body),
        },
      },
    ),
    [200],
  );
  await flushWaitUntilForTest();
  expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledTimes(1);
  const payload = object({
    unfurls: record(
      string(),
      object({
        blocks: array(
          object({
            type: string(),
            image_url: string().optional(),
          }),
        ),
      }),
    ),
  }).parse(context.mocks.slack.chat.unfurl.mock.calls[0]?.[0]);
  return pages.map((page) => {
    const image = payload.unfurls[page]?.blocks.find((block) => {
      return block.type === "image";
    })?.image_url;
    return image ? new URL(image) : null;
  });
}

function signedSource(url: URL | null | undefined) {
  if (!url) {
    throw new Error("Expected a transformed image URL");
  }
  expect(url.origin).toBe(env("OKOU_PUBLIC_ARTIFACTS_BASE_URL"));
  expect(url.pathname).toContain(
    "/cdn-cgi/image/width=320,height=112,fit=scale-down,format=auto,quality=85,metadata=none/",
  );
  expect(url.href.length).toBeLessThanOrEqual(3000);
  return new URL(url.href.split("metadata=none/")[1]!);
}

function readImage(url: URL) {
  expect(url.origin).toBe(
    new URL(string().parse(env("OKOU_API_BACKEND_URL"))).origin,
  );
  expect(url.pathname).toBe("/api/artifact-og/slack.png");
  return imageClient.slackImage({
    query: {
      url: string().parse(url.searchParams.get("url")),
      signature: string().parse(url.searchParams.get("signature")),
    },
  });
}

describe("Slack preview image URLs", () => {
  it("delivers a direct transformation URL whose signed source redirects to the literal original", async () => {
    const f = await fixture();
    const source =
      "https://images.example.com/original?token=a%2Fb%2Bc&size=large";
    const [url] = await previewUrls(f.teamId, [source]);
    const adapter = signedSource(url);
    expect(adapter.searchParams.get("url")).toBe(source);
    const response = await accept(readImage(adapter), [302]);
    expect(response.headers.get("location")).toBe(source);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("uses the existing policy-gated thumbnail URL for first-party file grants", async () => {
    const f = await fixture();
    const [url] = await previewUrls(f.teamId, [
      "https://a.okou.io/0123456789.png",
    ]);
    expect(url?.origin).toBe("https://a.okou.io");
    expect(url?.pathname).toBe("/0123456789.png");
    expect(Object.fromEntries(url?.searchParams ?? [])).toStrictEqual({
      thumbnail: "1",
      width: "320",
      height: "112",
      fit: "scale-down",
      quality: "85",
    });
  });

  it("resolves republished nested CF images to their original instead of another derivative", async () => {
    const f = await fixture();
    const original = "https://images.example.com/cover?signature=a%2Fb";
    const wrapped = `https://a.okou.io/cdn-cgi/image/width=500/https://cdn.vm7.io/cdn-cgi/image/height=200/${original}`;
    const [url] = await previewUrls(f.teamId, [wrapped]);
    const adapter = signedSource(url);
    const response = await accept(readImage(adapter), [302]);
    expect(response.headers.get("location")).toBe(original);
  });

  it("preserves HTTP, IPv6 and internal-host image sources for Cloudflare delivery", async () => {
    const f = await fixture();
    const sources = [
      "http://10.0.0.1/cover.png",
      "http://[fd00::1]/cover.png",
      "https://internal.local/cover.png",
    ];
    const urls = await previewUrls(f.teamId, sources);
    for (const [index, url] of urls.entries()) {
      const response = await accept(readImage(signedSource(url)), [302]);
      expect(response.headers.get("location")).toBe(sources[index]);
    }
  });

  it("keeps already-issued literal-URL HMAC capabilities resolving to originals", async () => {
    const original = "https://images.example.com/legacy.png?token=a%2Fb";
    const source = `https://a.okou.io/cdn-cgi/image/height=112/${original}`;
    // Fixture from the deployed v1 issuer: the HMAC binds the literal CF URL.
    const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
      .update("slack-preview-image:v1\0")
      .update(source)
      .digest("hex");
    const response = await accept(
      imageClient.slackImage({
        query: { url: source, signature },
      }),
      [302],
    );
    expect(response.headers.get("location")).toBe(original);
  });

  it("rejects modified signed capabilities and does not create nested adapters or unbounded Slack URLs", async () => {
    const f = await fixture();
    const [url] = await previewUrls(f.teamId, [
      "https://images.example.com/cover.png",
    ]);
    const adapter = signedSource(url);
    const changedSource = new URL(adapter);
    changedSource.searchParams.set(
      "url",
      "https://images.example.com/different.png",
    );
    await accept(readImage(changedSource), [403]);
    const changedSignature = new URL(adapter);
    changedSignature.searchParams.set("signature", "0".repeat(64));
    await accept(readImage(changedSignature), [403]);
    await expect(
      previewUrls(f.teamId, [
        adapter.href,
        `https://a.okou.io/cdn-cgi/image/width=500/${url!.href}`,
        `https://images.example.com/${"x".repeat(2048)}.png`,
        "https://images.example.com:4444/cover.png",
        `${env("APP_URL")}/artifacts/example.png`,
      ]),
    ).resolves.toStrictEqual([null, null, null, null, null]);
  });
});
