import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { env } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { artifactAccessRoutes } from "../artifact-access";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { mockClerkUsers } from "./helpers/clerk-users";
import { installArtifactFeishuForTest } from "./helpers/feishu-artifact-install";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function app(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return setupAppWithRoutes({
    context,
    routes: [
      ...artifactAccessRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
    ],
  });
}

function directory(users: readonly ApiTestUser[]) {
  mockClerkUsers(
    context,
    users.map((user) => {
      return {
        id: user.userId,
        firstName: "Chat",
        lastName: "Member",
        banned: false,
        primaryEmailAddressId: `email_${user.userId}`,
        emailAddresses: [
          {
            id: `email_${user.userId}`,
            emailAddress: user.email,
            verification: { status: "verified" },
          },
        ],
      };
    }),
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = object({
        organizationId: string(),
        userId: array(string()).optional(),
      }).parse(input);
      return Promise.resolve({
        data: users
          .filter((user) => {
            return (
              user.orgId === params.organizationId &&
              (!params.userId || params.userId.includes(user.userId))
            );
          })
          .map((user) => {
            return {
              organization: {
                id: params.organizationId,
                name: "Artifact workspace",
              },
              publicUserData: { userId: user.userId },
              role: user.orgRole,
            };
          }),
      });
    },
  );
}

async function fixture(
  platform: FeishuPlatform = "feishu",
  audience: "private" | "organization" | "public" = "private",
  kind: "file" | "site" = "file",
) {
  const candidate = createBddApi(context).user({ orgRole: "org:admin" });
  if (!candidate.orgId) {
    throw new Error("Expected an artifact workspace");
  }
  const owner = { ...candidate, orgId: candidate.orgId };
  const installation = await installArtifactFeishuForTest(
    context,
    owner,
    platform,
  );
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.ArtifactUserSharing]: true,
  });
  directory([owner]);
  const stored = createHostBddApi(context).captureHostedSitesS3();
  const storage = context.mocks.s3.send.getMockImplementation()!;
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
        ContentLength: 13,
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
        Body: Readable.from([Buffer.from("report bytes!")]),
        ContentLength: 13,
      });
    }
    return storage(operation, ...rest);
  });
  let resource: {
    readonly id: string;
    readonly kind: "file" | "site";
    readonly url: string;
  };
  if (kind === "site") {
    const host = createHostBddApi(context);
    const deployment = await host.prepareHostedSite(owner, {
      site: `chat-${randomUUID().slice(0, 8)}`,
      title: "Chat report",
      artifactKind: "hosted-site",
      spaFallback: false,
      visibility: audience,
      files: [
        hostedTextFile(
          "/index.html",
          '<html><head><title>Confidential website</title><meta name="description" content="Private analysis"></head><body>Report</body></html>',
        ),
      ],
    });
    for (const key of stored.objects.keys()) {
      if (key.endsWith("/index.html")) {
        stored.objects.set(
          key,
          '<html><head><title>Confidential website</title><meta name="description" content="Private analysis"></head><body>Report</body></html>',
        );
      }
    }
    const completed = await host.completeHostedSite(
      owner,
      deployment.deploymentId,
    );
    resource = {
      kind: "site",
      id: deployment.siteId,
      url: new URL(completed.artifactUrl ?? completed.url, env("APP_URL")).href,
    };
  } else {
    const prepared = await accept(
      app(owner)(uploadsContract).prepare({
        headers,
        body: {
          filename: "confidential-report.png",
          contentType: "image/png",
          size: 13,
          purpose: "artifact",
        },
      }),
      [200],
    );
    const completed = await accept(
      app(owner)(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    resource = {
      id: prepared.body.id,
      kind: "file",
      url: new URL(completed.body.url, env("APP_URL")).href,
    };
    if (audience !== "private") {
      await accept(
        app(owner)(artifactAccessContract).updateVisibility({
          headers,
          params: { artifactId: resource.id },
          body: { visibility: audience },
        }),
        [200],
      );
    }
  }
  const chatId = `oc_${randomUUID()}`;
  const members = [installation.ownerOpenId];
  const prompts: unknown[] = [];
  const updates: unknown[] = [];
  const refreshes: unknown[] = [];
  const uploadedImages: Blob[] = [];
  const base = `${installation.apiOrigin}/open-apis`;
  server.use(
    http.get(`${base}/im/v1/chats/${chatId}`, () => {
      return HttpResponse.json({ code: 0, data: { chat_mode: "group" } });
    }),
    http.get(`${base}/im/v1/chats/${chatId}/members/is_in_chat`, () => {
      return HttpResponse.json({ code: 0, data: { is_in_chat: true } });
    }),
    http.get(`${base}/im/v1/chats/${chatId}/members`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          items: members.map((id) => {
            return { member_id: id, member_id_type: "open_id" };
          }),
          has_more: false,
        },
      });
    }),
    http.post(`${base}/ephemeral/v1/send`, async ({ request }) => {
      prompts.push(await request.json());
      return HttpResponse.json({
        code: 0,
        data: { message_id: `om_${randomUUID()}` },
      });
    }),
    http.post(`${base}/interactive/v1/card/update`, async ({ request }) => {
      updates.push(await request.json());
      return HttpResponse.json({ code: 0 });
    }),
    http.post(
      `${base}/im/v2/url_previews/batch_update`,
      async ({ request }) => {
        refreshes.push(await request.json());
        return HttpResponse.json({ code: 0 });
      },
    ),
    http.post(`${base}/im/v1/images`, async ({ request }) => {
      const image = (await request.formData()).get("image");
      if (!(image instanceof Blob)) {
        throw new Error("Expected the preview image");
      }
      uploadedImages.push(image);
      return HttpResponse.json({
        code: 0,
        data: { image_key: "img_artifact_preview" },
      });
    }),
  );
  context.mocks.resend.send.mockResolvedValue({
    data: { id: randomUUID() },
    error: null,
  });
  context.mocks.resend.send.mockClear();
  const previewToken = `preview_${randomUUID()}`;
  return {
    ...installation,
    owner,
    resource,
    chatId,
    members,
    prompts,
    updates,
    refreshes,
    uploadedImages,
    previewToken,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function member(f: Fixture, sameWorkspace = true) {
  const user = createBddApi(context).user(
    sameWorkspace ? { orgId: f.owner.orgId } : {},
  );
  const openId = `ou_${randomUUID()}`;
  await f.bind(user, openId);
  f.members.push(openId);
  directory([f.owner, user]);
  return { ...user, openId };
}

async function preview(
  f: Fixture,
  openId = f.ownerOpenId,
  eventId = randomUUID(),
) {
  const response = await f.event(
    "url.preview.get",
    {
      operator: { open_id: openId, tenant_key: f.tenantKey },
      host: "im_message",
      context: {
        url: f.resource.url,
        preview_token: f.previewToken,
        open_message_id: "om_original",
        open_chat_id: f.chatId,
      },
    },
    eventId,
  );
  const body: unknown = await response.json();
  await flushWaitUntilForTest();
  return body;
}

function shareValue(f: Fixture, audience = "channel") {
  const card = object({
    card: object({
      body: object({
        elements: array(
          object({
            behaviors: array(
              object({
                type: string(),
                value: object({
                  action: string(),
                  token: string(),
                  audience: string(),
                }).optional(),
              }),
            ).optional(),
          }),
        ),
      }),
    }),
  }).parse(f.prompts.at(-1));
  const value = card.card.body.elements
    .flatMap((element) => {
      return element.behaviors ?? [];
    })
    .find((behavior) => {
      return behavior.value?.audience === audience;
    })?.value;
  if (!value) {
    throw new Error(`Expected the ${audience} share button`);
  }
  return value;
}

async function click(
  f: Fixture,
  options: {
    readonly audience?: string;
    readonly openId?: string;
    readonly chatId?: string;
  } = {},
) {
  const response = await f.event("card.action.trigger", {
    operator: { open_id: options.openId ?? f.ownerOpenId },
    context: { open_chat_id: options.chatId ?? f.chatId },
    token: "card_update_token",
    action: { value: shareValue(f, options.audience) },
  });
  const body: unknown = await response.json();
  await flushWaitUntilForTest();
  return body;
}

async function shares(f: Fixture) {
  return (
    await accept(
      app(f.owner)(artifactAccessContract).listShares({
        headers,
        params: { artifactId: f.resource.id },
      }),
      [200],
    )
  ).body;
}

test.each(["feishu", "lark"] as const)(
  "%s isolates viewer previews and refreshes after the owner shares current members",
  async (platform) => {
    const f = await fixture(platform);
    const viewer = await member(f);
    const denied = await preview(f, viewer.openId);
    expect(denied).toStrictEqual({ inline: { title: "Access required" } });
    expect(f.uploadedImages).toHaveLength(0);
    expect(f.prompts).toHaveLength(0);
    await expect(preview(f)).resolves.toMatchObject({
      inline: { title: "confidential-report.png" },
      card: { type: "raw" },
    });
    expect(f.uploadedImages).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toMatchObject({
      chat_id: f.chatId,
      open_id: f.ownerOpenId,
      msg_type: "interactive",
    });
    await expect(shares(f)).resolves.toMatchObject({ shares: [] });
    await click(f);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]).toMatchObject({ token: "card_update_token" });
    expect(f.refreshes).toStrictEqual([{ preview_tokens: [f.previewToken] }]);
    await expect(shares(f)).resolves.toMatchObject({
      shares: [expect.objectContaining({ email: viewer.email })],
    });
    await expect(preview(f, viewer.openId)).resolves.toMatchObject({
      inline: { title: "confidential-report.png" },
      card: { type: "raw" },
    });
    expect(f.prompts).toHaveLength(1);
    const status = await accept(
      app(f.owner)(artifactAccessContract).getVisibility({
        headers,
        params: { artifactId: f.resource.id },
      }),
      [200],
    );
    expect(status.body.visibility).toBe("private");
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    await click(f);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(f.refreshes).toHaveLength(1);
  },
);

test("an unbound viewer gets no protected title or image and stays unresolved after sharing", async () => {
  const f = await fixture();
  const unbound = `ou_${randomUUID()}`;
  f.members.push(unbound);
  await expect(preview(f, unbound)).resolves.toStrictEqual({
    inline: { title: "Sign in to Okou to view" },
  });
  await preview(f);
  await click(f);
  await expect(shares(f)).resolves.toMatchObject({ shares: [] });
  expect(JSON.stringify(f.updates)).toContain("1 could not be verified");
  expect(f.refreshes).toHaveLength(0);
});

test("workspace readers see previews without redundant owner prompts", async () => {
  const f = await fixture("feishu", "organization");
  const viewer = await member(f, true);
  await expect(preview(f, viewer.openId)).resolves.toHaveProperty("card");
  await preview(f);
  expect(f.prompts).toHaveLength(0);
  f.members.push(`ou_unbound_${randomUUID()}`);
  await preview(f);
  expect(JSON.stringify(f.prompts)).toContain(
    "Share with current chat members",
  );
  expect(JSON.stringify(f.prompts)).not.toContain("Share with workspace");
});

test.each(["user", "chat", "expired"])(
  "rejects a %s-mismatched or stale sharing action",
  async (mismatch) => {
    const f = await fixture();
    const viewer = await member(f);
    await preview(f);
    if (mismatch === "expired") {
      mockNow(new Date(now() + 16 * 60_000));
    }
    const result = await click(f, {
      openId: mismatch === "user" ? viewer.openId : undefined,
      chatId: mismatch === "chat" ? "oc_other" : undefined,
    });
    expect(result).toHaveProperty("toast");
    await expect(shares(f)).resolves.toMatchObject({ shares: [] });
    expect(f.updates).toHaveLength(0);
    expect(f.refreshes).toHaveLength(0);
  },
);

test("an incomplete member list never writes partial grants", async () => {
  const f = await fixture();
  await member(f);
  await preview(f);
  server.use(
    http.get(`${f.apiOrigin}/open-apis/im/v1/chats/${f.chatId}/members`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          items: [{ member_id: f.ownerOpenId, member_id_type: "open_id" }],
          has_more: true,
        },
      });
    }),
  );
  await click(f);
  await expect(shares(f)).resolves.toMatchObject({ shares: [] });
  expect(JSON.stringify(f.updates)).toContain("could not be verified");
  expect(f.refreshes).toHaveLength(0);
});

test("a public artifact can be previewed by an unbound reader without sharing prompts", async () => {
  const f = await fixture("lark", "public");
  await expect(preview(f, "ou_unbound")).resolves.toMatchObject({
    inline: { title: "confidential-report.png" },
    card: { type: "raw" },
  });
  expect(f.prompts).toHaveLength(0);
  expect(f.uploadedImages).toHaveLength(1);
});

test("hosted websites use the same viewer checks and current-member sharing", async () => {
  const f = await fixture("lark", "private", "site");
  const viewer = await member(f);
  await expect(preview(f, viewer.openId)).resolves.toStrictEqual({
    inline: { title: "Access required" },
  });
  await expect(preview(f)).resolves.toMatchObject({
    inline: { title: "Confidential website" },
    card: { type: "raw" },
  });
  await click(f);
  await expect(shares(f)).resolves.toMatchObject({
    shares: [expect.objectContaining({ email: viewer.email })],
  });
  await expect(preview(f, viewer.openId)).resolves.toHaveProperty("card");
  expect(f.refreshes).toStrictEqual([{ preview_tokens: [f.previewToken] }]);
});

test.each(["organization", "public"])(
  "an explicit %s visibility change refreshes viewer previews",
  async (audience) => {
    const f = await fixture();
    await member(f);
    await preview(f);
    await click(f, { audience });
    const status = await accept(
      app(f.owner)(artifactAccessContract).getVisibility({
        headers,
        params: { artifactId: f.resource.id },
      }),
      [200],
    );
    expect(status.body.visibility).toBe(audience);
    expect(f.refreshes).toStrictEqual([{ preview_tokens: [f.previewToken] }]);
  },
);

test("repeated preview callbacks send only one owner prompt per message", async () => {
  const f = await fixture();
  f.members.push("ou_unbound");
  const eventId = randomUUID();
  await preview(f, f.ownerOpenId, eventId);
  await preview(f, f.ownerOpenId, eventId);
  await preview(f);
  expect(f.prompts).toHaveLength(1);
});

test("member pagination follows an empty page before determining access", async () => {
  const f = await fixture();
  const viewer = await member(f);
  server.use(
    http.get(
      `${f.apiOrigin}/open-apis/im/v1/chats/${f.chatId}/members`,
      ({ request }) => {
        const next = new URL(request.url).searchParams.get("page_token");
        return HttpResponse.json({
          code: 0,
          data: next
            ? {
                items: f.members.map((id) => {
                  return { member_id: id, member_id_type: "open_id" };
                }),
                has_more: false,
              }
            : { items: [], has_more: true, page_token: "next-page" },
        });
      },
    ),
  );
  await preview(f);
  await click(f);
  await expect(shares(f)).resolves.toMatchObject({
    shares: [expect.objectContaining({ email: viewer.email })],
  });
});

test("unsupported conversations receive no ephemeral sharing prompt", async () => {
  const f = await fixture();
  server.use(
    http.get(`${f.apiOrigin}/open-apis/im/v1/chats/${f.chatId}`, () => {
      return HttpResponse.json({ code: 0, data: { chat_mode: "topic" } });
    }),
  );
  await expect(preview(f)).resolves.toHaveProperty("card");
  expect(f.prompts).toHaveLength(0);
});

test("slow preview uploads respect the callback deadline while the owner still receives sharing controls", async () => {
  const f = await fixture();
  f.members.push("ou_unbound");
  server.use(
    http.post(`${f.apiOrigin}/open-apis/im/v1/images`, async ({ request }) => {
      const aborted = createDeferredPromise<void>(context.signal);
      if (request.signal.aborted) {
        aborted.resolve();
      } else {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
      }
      await aborted.promise;
      return HttpResponse.error();
    }),
  );
  await expect(preview(f)).resolves.toStrictEqual({});
  expect(f.prompts).toHaveLength(1);
});
