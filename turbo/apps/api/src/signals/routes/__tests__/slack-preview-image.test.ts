import { randomUUID } from "node:crypto";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { escapeAttribute } from "entities/escape";
import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
const maxBytes = 5 * 1024 * 1024;
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
  const payload = z
    .object({
      unfurls: z.record(
        z.string(),
        z.object({
          blocks: z.array(
            z.object({
              type: z.string(),
              image_url: z.string().optional(),
            }),
          ),
        }),
      ),
    })
    .parse(context.mocks.slack.chat.unfurl.mock.calls[0]?.[0]);
  return pages.map((page) => {
    const image = payload.unfurls[page]?.blocks.find((block) => {
      return block.type === "image";
    })?.image_url;
    return image ? new URL(image) : null;
  });
}

function readImage(url: URL | null | undefined) {
  if (!url) {
    throw new Error("Expected a signed thumbnail URL");
  }
  expect(url.origin).toBe(
    new URL(z.string().parse(env("OKOU_API_BACKEND_URL"))).origin,
  );
  expect(url.pathname).toBe("/api/artifact-og/slack.png");
  return imageClient.slackImage({
    query: {
      url: z.string().parse(url.searchParams.get("url")),
      signature: z.string().parse(url.searchParams.get("signature")),
    },
  });
}

async function expectEmptyImage(url: URL | null | undefined) {
  const response = await accept(readImage(url), [200]);
  expect(response.headers.get("location")).toBeNull();
  const bytes = Buffer.from(await response.body.arrayBuffer());
  const decoded = await sharp(bytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(decoded.info).toMatchObject({ width: 1, height: 1, channels: 4 });
  expect([...decoded.data]).toStrictEqual([0, 0, 0, 0]);
}

async function png(width: number, height: number) {
  return await sharp({
    create: { width, height, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
}

describe("Slack preview thumbnails", () => {
  it("fits every aspect ratio inside 320 by 112 pixels without enlarging small images", async () => {
    const f = await fixture();
    const cases = [
      { width: 1280, height: 640, output: [224, 112] },
      { width: 1200, height: 120, output: [320, 32] },
      { width: 120, height: 960, output: [14, 112] },
      { width: 24, height: 12, output: [24, 12] },
    ];
    const origins = [
      "https://images.example.com",
      "http://10.0.0.1",
      "http://[fd00::1]",
      "https://internal.local",
    ];
    const sources = origins.map((origin, index) => {
      return `${origin}/${index}.png`;
    });
    const requests: Request[] = [];
    for (const [index, dimensions] of cases.entries()) {
      const bytes = await png(dimensions.width, dimensions.height);
      server.use(
        http.get(new RegExp(`/${index}\\.png$`, "u"), ({ request }) => {
          expect(request.url).toBe(sources[index]);
          requests.push(request);
          return new HttpResponse(new Uint8Array(bytes), {
            headers: { "content-type": "image/png" },
          });
        }),
      );
    }
    const urls = await previewUrls(f.teamId, sources);
    for (const [index, url] of urls.entries()) {
      const response = await accept(readImage(url), [200]);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const bytes = Buffer.from(await response.body.arrayBuffer());
      const decoded = await sharp(bytes)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([decoded.info.width, decoded.info.height]).toStrictEqual(
        cases[index]!.output,
      );
      expect(bytes.length).toBeLessThanOrEqual(maxBytes);
    }
    expect(requests).toHaveLength(cases.length);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("accept-encoding")).toBe("identity");
    }
  });

  it("bounds declared and streamed bytes, input pixels and invalid image formats", async () => {
    const f = await fixture();
    const small = await png(20, 10);
    const tooManyPixels = await png(4097, 4096);
    const cases = [
      { body: small, headers: { "content-length": String(maxBytes + 1) } },
      { body: Buffer.alloc(maxBytes + 1), headers: {} },
      { body: Buffer.alloc(maxBytes + 1), headers: { "content-length": "1" } },
      { body: tooManyPixels, headers: {} },
      { body: Buffer.from("invalid image"), headers: {} },
      {
        body: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>',
        ),
        headers: { "content-type": "image/svg+xml" },
      },
      { body: small, headers: { "content-encoding": "gzip" } },
      { body: small, headers: { "content-type": "text/html" } },
    ];
    const sources = cases.map((_, index) => {
      return `https://images.example.com/bad-${index}.png`;
    });
    for (const [index, source] of sources.entries()) {
      const testCase = cases[index]!;
      server.use(
        http.get(source, () => {
          return new HttpResponse(new Uint8Array(testCase.body), {
            headers: { "content-type": "image/png", ...testCase.headers },
          });
        }),
      );
    }
    const urls = await previewUrls(f.teamId, sources);
    expect(urls).toHaveLength(cases.length);
    for (const url of urls) {
      await expectEmptyImage(url);
    }
  });

  it("never follows redirects or fetches sources on non-default ports", async () => {
    const f = await fixture();
    const sources = [
      "https://images.example.com/redirect.png",
      "https://images.example.com:4444/cover.png",
    ];
    const requests: string[] = [];
    server.use(
      http.get("*", ({ request }) => {
        requests.push(request.url);
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      }),
    );
    const urls = await previewUrls(f.teamId, sources);
    for (const url of urls) {
      await expectEmptyImage(url);
    }
    expect(requests).toStrictEqual([sources[0]]);
  });

  it("rejects tampered signatures before network access and avoids nested or oversized thumbnail URLs", async () => {
    const f = await fixture();
    const [url] = await previewUrls(f.teamId, [
      "https://images.example.com/cover.png",
    ]);
    if (!url) {
      throw new Error("Expected a signed image URL");
    }
    const requests: string[] = [];
    server.use(
      http.get("https://images.example.com/*", ({ request }) => {
        requests.push(request.url);
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const changedSource = new URL(url);
    changedSource.searchParams.set(
      "url",
      "https://images.example.com/different.png",
    );
    await accept(readImage(changedSource), [403]);
    const changedSignature = new URL(url);
    changedSignature.searchParams.set("signature", "0".repeat(64));
    await accept(readImage(changedSignature), [403]);
    expect(requests).toStrictEqual([]);
    await expect(
      previewUrls(f.teamId, [
        url.href,
        `https://images.example.com/${"x".repeat(2048)}.png`,
      ]),
    ).resolves.toStrictEqual([null, null]);
  });
});
