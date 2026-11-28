import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactAccessRoutes } from "../artifact-access";
import { hostRoutes } from "../host";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createArtifactFeishuInstaller } from "./helpers/feishu-artifact-install";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const feishuInstaller = createArtifactFeishuInstaller(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const appClient = setupAppWithRoutes({
  context,
  routes: [
    ...artifactAccessRoutes,
    ...hostRoutes,
    ...uploadsPrepareRoutes,
    ...uploadsCompleteRoutes,
  ],
});

function app(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return appClient;
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
  options: {
    readonly viewer?: "sameWorkspace" | "external";
    readonly bindOwner?: boolean;
  } = {},
) {
  const candidate = createBddApi(context).user({ orgRole: "org:admin" });
  if (!candidate.orgId) {
    throw new Error("Expected an artifact workspace");
  }
  const owner = { ...candidate, orgId: candidate.orgId };
  const viewerUser = options.viewer
    ? {
        ...createBddApi(context).user(
          options.viewer === "sameWorkspace" ? { orgId: owner.orgId } : {},
        ),
        openId: `ou_${randomUUID()}`,
      }
    : undefined;
  directory(viewerUser ? [owner, viewerUser] : [owner]);
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
  async function createResource(): Promise<{
    readonly id: string;
    readonly kind: "file" | "site";
    readonly url: string;
  }> {
    if (kind === "site") {
      const html =
        '<html><head><title>Confidential website</title><meta name="description" content="Private analysis"></head><body>Report</body></html>';
      const deployment = (
        await accept(
          appClient(hostContract).prepare({
            headers,
            body: {
              site: `chat-${randomUUID().slice(0, 8)}`,
              title: "Chat report",
              artifactKind: "hosted-site",
              spaFallback: false,
              visibility: audience,
              files: [hostedTextFile("/index.html", html)],
            },
          }),
          [200],
        )
      ).body;
      for (const key of stored.objects.keys()) {
        if (key.endsWith("/index.html")) {
          stored.objects.set(key, html);
        }
      }
      const completed = (
        await accept(
          appClient(hostContract).complete({
            headers,
            params: { deploymentId: deployment.deploymentId },
            body: {},
          }),
          [200],
        )
      ).body;
      return {
        kind: "site",
        id: deployment.siteId,
        url: new URL(completed.artifactUrl ?? completed.url, env("APP_URL"))
          .href,
      };
    }
    const prepared = await accept(
      appClient(uploadsContract).prepare({
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
      appClient(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    if (audience !== "private") {
      await accept(
        appClient(artifactAccessContract).updateVisibility({
          headers,
          params: { artifactId: prepared.body.id },
          body: { visibility: audience },
        }),
        [200],
      );
    }
    return {
      id: prepared.body.id,
      kind: "file",
      url: new URL(completed.body.url, env("APP_URL")).href,
    };
  }
  const [installation, resource] = await Promise.all([
    feishuInstaller.install(owner, platform, {
      extraSwitches: { [FeatureSwitchKey.ArtifactUserSharing]: true },
      bindOwner: options.bindOwner,
      extraMembers: viewerUser
        ? [{ user: viewerUser, openId: viewerUser.openId }]
        : [],
    }),
    createResource(),
  ]);
  const chatId = `oc_${randomUUID()}`;
  const members = viewerUser
    ? [installation.ownerOpenId, viewerUser.openId]
    : [installation.ownerOpenId];
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
    viewer: viewerUser,
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

function requireViewer(f: Fixture) {
  if (!f.viewer) {
    throw new Error("Expected a bound viewer");
  }
  return f.viewer;
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
  await flushWaitUntilForTest();
  return response.body;
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
  await flushWaitUntilForTest();
  return response.body;
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

test("feishu denies viewer previews before the owner shares", async () => {
  const f = await fixture("feishu", "private", "file", {
    viewer: "sameWorkspace",
    bindOwner: false,
  });
  const viewer = requireViewer(f);
  const denied = await preview(f, viewer.openId);
  expect(denied).toStrictEqual({ inline: { title: "Access required" } });
  expect(f.uploadedImages).toHaveLength(0);
  expect(f.prompts).toHaveLength(0);
});

test("feishu renders the owner preview and sends private sharing controls without granting access", async () => {
  const f = await fixture("feishu");
  f.members.push(`ou_other_${randomUUID()}`);
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
});

test("an unbound viewer gets no protected title or image", async () => {
  const f = await fixture("feishu", "private", "file", { bindOwner: false });
  const unbound = `ou_${randomUUID()}`;
  f.members.push(unbound);
  await expect(preview(f, unbound)).resolves.toStrictEqual({
    inline: { title: "Sign in to Okou to view" },
  });
  expect(f.uploadedImages).toHaveLength(0);
  expect(f.prompts).toHaveLength(0);
});

test("sharing a private file leaves an unbound chat member unresolved", async () => {
  const f = await fixture();
  const unbound = `ou_${randomUUID()}`;
  f.members.push(unbound);
  await preview(f);
  await click(f);
  await expect(shares(f)).resolves.toMatchObject({ shares: [] });
  expect(JSON.stringify(f.updates)).toContain("1 could not be verified");
  expect(f.refreshes).toHaveLength(0);
});

test("workspace readers see previews for organization-visible files", async () => {
  const f = await fixture("feishu", "organization", "file", {
    viewer: "sameWorkspace",
    bindOwner: false,
  });
  const viewer = requireViewer(f);
  await expect(preview(f, viewer.openId)).resolves.toHaveProperty("card");
});

test("rejects a user-mismatched sharing action", async () => {
  const f = await fixture();
  const otherOpenId = `ou_other_${randomUUID()}`;
  f.members.push(otherOpenId);
  await preview(f);
  const result = await click(f, { openId: otherOpenId });
  expect(result).toHaveProperty("toast");
  await expect(shares(f)).resolves.toMatchObject({ shares: [] });
  expect(f.updates).toHaveLength(0);
  expect(f.refreshes).toHaveLength(0);
});

test("a public artifact can be previewed by an unbound reader without sharing prompts", async () => {
  const f = await fixture("lark", "public", "file", { bindOwner: false });
  await expect(preview(f, "ou_unbound")).resolves.toMatchObject({
    inline: { title: "confidential-report.png" },
    card: { type: "raw" },
  });
  expect(f.prompts).toHaveLength(0);
  expect(f.uploadedImages).toHaveLength(1);
});

test("hosted websites deny viewer previews before sharing", async () => {
  const f = await fixture("feishu", "private", "site", {
    viewer: "sameWorkspace",
    bindOwner: false,
  });
  const viewer = requireViewer(f);
  await expect(preview(f, viewer.openId)).resolves.toStrictEqual({
    inline: { title: "Access required" },
  });
});

test("an explicit organization visibility change refreshes viewer previews", async () => {
  const f = await fixture();
  f.members.push(`ou_other_${randomUUID()}`);
  await preview(f);
  await click(f, { audience: "organization" });
  const status = await accept(
    app(f.owner)(artifactAccessContract).getVisibility({
      headers,
      params: { artifactId: f.resource.id },
    }),
    [200],
  );
  expect(status.body.visibility).toBe("organization");
  expect(f.refreshes).toStrictEqual([{ preview_tokens: [f.previewToken] }]);
});
