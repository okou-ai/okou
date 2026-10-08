import { gzipSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { http, HttpResponse } from "msw";
import { Header } from "tar";
import type { TestContext } from "../../../../__tests__/test-context";
import { server } from "../../../../mocks/server";
import { mockOptionalEnv } from "../../../../lib/env";
import { createBddApi, type ApiTestUserOptions } from "./api-bdd";
import { createRunsApi, expectCanonicalStorageManifest } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { createFirewallApi } from "./api-bdd-firewall";
import { configureNativeCliArtifact } from "./chat-events-fixture";
import { createPublicFirewallFixture } from "./public-firewall-fixture";

export function memoryArchive(path: string, content: string): Buffer {
  return memoryFilesArchive([{ path, content }]);
}

export function memoryFilesArchive(
  files: readonly { path: string; content: string }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const { path, content } of files) {
    const bytes = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    new Header({ path, size: bytes.length, type: "File", mode: 0o644 }).encode(
      header,
    );
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Ordinary storage owners originate in paid onboarding and real Runner claims. */
export function createPublicRunnerMemory(
  context: TestContext,
  options: ApiTestUserOptions = {},
) {
  const fixture = createPublicFirewallFixture(context, options);
  const api = createRunsApi(context);
  const bdd = createBddApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const objects = new Map<string, Buffer>();
  function installObjects() {
    context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
      const key = (command as { input?: { Key?: string } }).input?.Key;
      if (!key) {
        throw new Error("Expected an owned storage object key");
      }
      return Promise.resolve(
        `https://r2.example.com/owned-memory/${encodeURIComponent(key)}`,
      );
    });
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (
        command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand
      ) {
        const bytes = command.input.Key
          ? objects.get(command.input.Key)
          : undefined;
        if (!bytes) {
          throw Object.assign(new Error("Missing owned storage object"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        return Promise.resolve({
          ContentLength: bytes.length,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield bytes;
            },
          },
        });
      }
      return Promise.resolve({});
    });
    server.use(
      http.get("https://r2.example.com/owned-memory/:key", ({ params }) => {
        const key =
          typeof params.key === "string" ? decodeURIComponent(params.key) : "";
        const bytes = objects.get(key);
        return bytes
          ? new HttpResponse(new Uint8Array(bytes))
          : new HttpResponse(null, { status: 404 });
      }),
    );
  }
  async function initializeNative() {
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    configureNativeCliArtifact();
    const admin =
      fixture.actor.orgRole === "org:member"
        ? bdd.user({ orgId: fixture.actor.orgId, orgRole: "org:admin" })
        : fixture.actor;
    // Only an admin can initialize the organization's default Agent. The
    // member remains the owner of the Memory, Agent and Runner claims below.
    await fixture.fund(admin);
    await api.ensurePersonalSubscriptionModel(fixture.actor, {
      model: "claude-fable-5-1",
    });
    createFirewallApi(context).seedClerkDirectory(fixture.actor);
    if (admin.userId !== fixture.actor.userId) {
      await bdd.completeOnboarding(fixture.actor);
    }
    const agent = await bdd.createAgent(fixture.actor, {
      displayName: "Owned Memory carrier",
      visibility: "private",
    });
    fixture.registerAgent(agent.agentId);
    return agent.agentId;
  }
  async function claim(agentId: string, prompt: string) {
    const run = await api.createThreadRun(fixture.actor, {
      agentId,
      prompt,
      // The Memory owner selects their own connected native subscription;
      // the organization admin's personal credentials are never borrowed.
      model: "claude-fable-5-1",
    });
    fixture.registerRun(run.runId);
    const execution = await api.claimRunnerJob(run.runId);
    fixture.registerClaim(run.runId, execution.sandboxToken);
    const manifest = expectCanonicalStorageManifest(execution.storageManifest);
    const memories =
      manifest?.storageMounts.filter((mount) => {
        return mount.name === "memory";
      }) ?? [];
    if (memories.length !== 1 || !memories[0]?.storageId) {
      throw new Error("Expected exactly one real Memory mount");
    }
    return {
      run,
      execution,
      memory: memories[0],
      headers: { authorization: `Bearer ${execution.sandboxToken}` },
    };
  }
  return {
    ...fixture,
    api,
    bdd,
    webhooks,
    initializeNative,
    claim,
    objects,
    installObjects,
  };
}
