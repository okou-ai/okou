import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  marketingHandoffsContract,
  serializeMarketingHandoff,
  type MarketingHandoffManifest,
} from "@okouai/api-contracts/contracts/marketing-handoffs";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { marketingHandoffsRoutes } from "../marketing-handoffs";
import { webFileUrlRoutes } from "../web-file-url";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

describe("Marketing content handoff", () => {
  const context = testContext();
  const mocks = createRouteMocks(context);
  const origin = "https://www.okou.ai";
  const auth = { authorization: "Bearer clerk-session" };
  const publisher = {
    authorization: `Bearer ${"publisher-credential-".repeat(3)}`,
  };
  const routes = [...marketingHandoffsRoutes, ...webFileUrlRoutes];
  const api = () => {
    return setupApp({ context, routes })(marketingHandoffsContract);
  };
  let actor = { userId: "", orgId: "" };
  let taskId = "";
  let intentId = "";
  let objects = new Map<
    string,
    { bytes: Buffer; type: string; metadata: Record<string, string> }
  >();

  async function enableActor() {
    actor = { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
    await updateFeatureSwitchesForUser(context, actor, {
      marketingContentHandoff: true,
    });
    return actor;
  }

  function manifest(
    prompt = `Prepare a business report ${taskId}`,
  ): MarketingHandoffManifest {
    return { version: 1, prompt, options: {}, files: [] };
  }

  async function create(
    body = manifest(),
    cookie?: string,
    authenticated = true,
  ) {
    return await accept(
      api().create({
        body,
        headers: authenticated ? auth : {},
        extraHeaders: { origin, ...(cookie ? { cookie } : {}) },
      }),
      [200],
    );
  }

  async function guestCookie() {
    const response = await accept(
      api().session({ body: {}, headers: auth, extraHeaders: { origin } }),
      [200],
    );
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
    if (!cookie) {
      throw new Error("Missing guest cookie");
    }
    return cookie.split(";")[0]!;
  }

  beforeEach(async () => {
    taskId = randomUUID();
    intentId = randomUUID();
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", origin);
    mockEnv("R2_MARKETING_HANDOFF_BUCKET_NAME", "test-marketing-handoffs");
    mockEnv("R2_MARKETING_HANDOFF_ACCESS_KEY_ID", "test-marketing-key");
    mockEnv("R2_MARKETING_HANDOFF_SECRET_ACCESS_KEY", "test-marketing-secret");
    mockEnv(
      "MARKETING_HANDOFF_PUBLISH_TOKEN",
      "publisher-credential-".repeat(3),
    );
    objects = new Map();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const key = `${command.input.Bucket}/${command.input.Key}`;
        if (command.input.IfNoneMatch === "*" && objects.has(key)) {
          return Promise.reject(
            Object.assign(new Error("Exists"), {
              name: "PreconditionFailed",
              $metadata: { httpStatusCode: 412 },
            }),
          );
        }
        const body = command.input.Body;
        if (typeof body !== "string" && !(body instanceof Uint8Array)) {
          throw new Error("Unexpected upload body");
        }
        objects.set(key, {
          bytes:
            typeof body === "string" ? Buffer.from(body) : Buffer.from(body),
          type: command.input.ContentType ?? "application/octet-stream",
          metadata: command.input.Metadata ?? {},
        });
        return Promise.resolve({ ETag: '"stored"' });
      }
      if (
        command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand
      ) {
        const object = objects.get(
          `${command.input.Bucket}/${command.input.Key}`,
        );
        if (!object) {
          return Promise.reject(
            Object.assign(new Error("Missing"), {
              name: "NoSuchKey",
              $metadata: { httpStatusCode: 404 },
            }),
          );
        }
        return Promise.resolve({
          Body: Readable.from([object.bytes]),
          ContentLength: object.bytes.length,
          ContentType: object.type,
          Metadata: object.metadata,
          ETag: '"stored"',
        });
      }
      throw new Error("Unexpected storage operation");
    });
    await enableActor();
  });

  it.each([".", ".."])(
    'rejects the special filename "%s" before storing content',
    async (filename) => {
      const response = await api().upload({
        body: {
          filename,
          contentType: "text/plain",
          data: Buffer.from("Feedback").toString("base64"),
        },
        headers: auth,
        extraHeaders: { origin },
      });
      expect(response.status).toBe(400);
    },
  );

  it("keeps identical content stable, versions edits, and leaves the old manifest readable", async () => {
    const first = await create();
    const duplicate = await create();
    const edited = await create(manifest("A different task"));
    expect(first.body.shortHash).toBe(first.body.hash.slice(0, 12));
    expect(duplicate.body.hash).toBe(first.body.hash);
    expect(edited.body.hash).not.toBe(first.body.hash);
    const resolved = await accept(
      api().resolve({
        params: first.body,
        body: {},
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual(manifest());
    const short = await accept(
      api().resolve({
        params: { hash: first.body.shortHash },
        body: {},
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    expect(short.body).toStrictEqual(resolved.body);
  });

  it("rejects a colliding short address without overwriting or granting access to the first task", async () => {
    const firstActor = actor;
    const firstManifest = manifest("Short handoff collision 12975700");
    const first = await create(firstManifest);
    const colliding = manifest("Short handoff collision 15460718");
    await enableActor();
    const rejected = await api().create({
      body: colliding,
      headers: auth,
      extraHeaders: { origin },
    });
    expect(rejected.status).toBe(409);
    const rejectedPublication = await api().publish({
      headers: publisher,
      body: colliding,
    });
    expect(rejectedPublication.status).toBe(409);
    expect(
      (
        await api().resolve({
          params: { hash: first.body.shortHash },
          body: {},
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(404);
    mocks.clerk.session(firstActor.userId, firstActor.orgId);
    const resolved = await accept(
      api().resolve({
        params: { hash: first.body.shortHash },
        body: {},
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual(firstManifest);
  });

  it("reserves a short address for only one of two concurrent colliding tasks", async () => {
    const bodies = [
      manifest("Short handoff collision 12975700"),
      manifest("Short handoff collision 15460718"),
    ];
    const responses = await Promise.all(
      bodies.map((body) => {
        return api().create({ body, headers: auth, extraHeaders: { origin } });
      }),
    );
    expect(
      responses
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const resolved = await accept(
      api().resolve({
        params: { hash: "23aab54ca8ed" },
        body: {},
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual(
      bodies[
        responses.findIndex((response) => {
          return response.status === 200;
        })
      ],
    );
  });

  it("returns not found for an unknown short address", async () => {
    const response = await api().resolve({
      params: { hash: "000000000000" },
      body: {},
      headers: auth,
      extraHeaders: { origin },
    });
    expect(response.status).toBe(404);
  });

  it("does not grant another user access merely because they know the hash", async () => {
    const created = await create();
    await enableActor();
    const result = await api().resolve({
      params: { hash: created.body.shortHash },
      body: {},
      headers: auth,
      extraHeaders: { origin },
    });
    expect(result.status).toBe(404);
  });

  it("gives independent grants to two users who submit identical content", async () => {
    const firstActor = actor;
    const first = await create();
    await enableActor();
    const second = await create();
    expect(second.body.hash).toBe(first.body.hash);
    mocks.clerk.session(firstActor.userId, firstActor.orgId);
    expect(
      (
        await api().resolve({
          params: first.body,
          body: {},
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(200);
  });

  it("reuses the handoff transport across independent publication requests", async () => {
    for (const prompt of ["First preset", "Second preset", "Third preset"]) {
      await accept(
        api().publish({ headers: publisher, body: manifest(prompt) }),
        [200],
      );
    }
    const configs = context.mocks.s3.requestConfig.mock.calls.map(
      ([config]) => {
        return config as S3ClientConfig;
      },
    );
    const transport = configs[0]?.requestHandler;
    expect(transport).toBeDefined();
    for (const config of configs) {
      expect(config.requestHandler).toBe(transport);
      expect(config.credentials).toMatchObject({
        accessKeyId: "test-marketing-key",
        secretAccessKey: "test-marketing-secret",
      });
    }
  });

  it("checks public publication receipts without exposing private handoffs", async () => {
    const privateHandoff = await create();
    const published = await accept(
      api().publish({
        headers: publisher,
        body: manifest(`Public preset ${taskId}`),
      }),
      [200],
    );
    const response = await accept(
      api().publishStatus({
        headers: publisher,
        body: {
          hashes: [
            published.body.hash,
            privateHandoff.body.hash,
            privateHandoff.body.hash,
          ],
        },
      }),
      [200],
    );
    expect(response.body.missing).toStrictEqual([privateHandoff.body.hash]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await api().publishStatus({
          headers: auth,
          body: { hashes: [privateHandoff.body.hash] },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api().publishBatch({
          headers: auth,
          body: { manifests: [manifest()] },
        })
      ).status,
    ).toBe(403);
  });

  it("publishes only missing unique manifests and reuses the single-publish receipts", async () => {
    const existing = manifest(`Existing preset ${taskId}`);
    const added = manifest(`New preset ${taskId}`);
    const first = await accept(
      api().publish({ headers: publisher, body: existing }),
      [200],
    );
    const puts = () => {
      return context.mocks.s3.send.mock.calls.filter(([request]) => {
        return request instanceof PutObjectCommand;
      }).length;
    };
    const before = puts();
    const batch = await accept(
      api().publishBatch({
        headers: publisher,
        body: { manifests: [existing, added, added] },
      }),
      [200],
    );
    const newHash = createHash("sha256")
      .update(serializeMarketingHandoff(added))
      .digest("hex");
    expect(batch.body.hashes).toStrictEqual([first.body.hash, newHash]);
    expect(puts() - before).toBe(2);
    await accept(
      api().publishBatch({
        headers: publisher,
        body: { manifests: [added, existing] },
      }),
      [200],
    );
    expect(puts() - before).toBe(2);
    const status = await accept(
      api().publishStatus({
        headers: publisher,
        body: { hashes: batch.body.hashes },
      }),
      [200],
    );
    expect(status.body.missing).toStrictEqual([]);
    await enableActor();
    const resolved = await accept(
      api().resolve({
        headers: auth,
        extraHeaders: { origin },
        params: { hash: newHash },
        body: {},
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual(added);
    const short = await accept(
      api().resolve({
        headers: auth,
        extraHeaders: { origin },
        params: { hash: newHash.slice(0, 12) },
        body: {},
      }),
      [200],
    );
    expect(short.body).toStrictEqual(added);
  });

  it("repairs a full-only public receipt before inventory accepts its short address", async () => {
    const body = manifest(`Legacy public preset ${taskId}`);
    const published = await accept(
      api().publish({ headers: publisher, body }),
      [200],
    );
    objects.delete(
      `test-marketing-handoffs/manifest/${published.body.shortHash}.json`,
    );
    const inventory = () => {
      return accept(
        api().publishStatus({
          headers: publisher,
          body: { hashes: [published.body.hash] },
        }),
        [200],
      );
    };
    expect((await inventory()).body).toStrictEqual({
      missing: [published.body.hash],
      shortAddressesVerified: true,
    });
    await accept(
      api().publishBatch({ headers: publisher, body: { manifests: [body] } }),
      [200],
    );
    expect((await inventory()).body.missing).toStrictEqual([]);
    await enableActor();
    const resolved = await accept(
      api().resolve({
        headers: auth,
        extraHeaders: { origin },
        params: { hash: published.body.shortHash! },
        body: {},
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual(body);
  });

  it("rejects a colliding batch without granting access to any unpublished manifest", async () => {
    const bodies = [
      manifest("Short handoff collision 12975700"),
      manifest("Short handoff collision 15460718"),
      manifest(`Unrelated preset ${taskId}`),
    ];
    const hashes = bodies.map((body) => {
      return createHash("sha256")
        .update(serializeMarketingHandoff(body))
        .digest("hex");
    });
    const failed = await api().publishBatch({
      headers: publisher,
      body: { manifests: bodies },
    });
    expect(failed.status).toBe(409);
    const inventory = await accept(
      api().publishStatus({ headers: publisher, body: { hashes } }),
      [200],
    );
    expect(inventory.body.missing).toStrictEqual(hashes);
    await enableActor();
    for (const hash of [...hashes, hashes[0]!.slice(0, 12)]) {
      expect(
        (
          await api().resolve({
            headers: auth,
            extraHeaders: { origin },
            params: { hash },
            body: {},
          })
        ).status,
      ).toBe(404);
    }
  });

  it("does not make private files public through batch publication", async () => {
    const file = await accept(
      api().upload({
        headers: auth,
        extraHeaders: { origin },
        body: {
          filename: "private.txt",
          contentType: "text/plain",
          data: Buffer.from(taskId).toString("base64"),
        },
      }),
      [200],
    );
    const body = { ...manifest(), files: [file.body] };
    const result = await api().publishBatch({
      headers: publisher,
      body: { manifests: [body] },
    });
    expect(result.status).toBe(404);
    const hash = createHash("sha256")
      .update(serializeMarketingHandoff(body))
      .digest("hex");
    const status = await accept(
      api().publishStatus({ headers: publisher, body: { hashes: [hash] } }),
      [200],
    );
    expect(status.body.missing).toStrictEqual([hash]);
    await enableActor();
    expect(
      (
        await api().resolve({
          headers: auth,
          extraHeaders: { origin },
          params: { hash },
          body: {},
        })
      ).status,
    ).toBe(404);
  });

  it("keeps a partially failed batch unpublished and safely retries its immutable objects", async () => {
    const manifests = [
      manifest(`First ${taskId}`),
      manifest(`Second ${taskId}`),
    ];
    const hashes = manifests.map((body) => {
      return createHash("sha256")
        .update(serializeMarketingHandoff(body))
        .digest("hex");
    });
    context.mocks.s3.send.mockRejectedValueOnce(
      new Error("Storage unavailable"),
    );
    const failed = await api().publishBatch({
      headers: publisher,
      body: { manifests },
    });
    expect(failed.status).toBe(500);
    const unpublished = await accept(
      api().publishStatus({ headers: publisher, body: { hashes } }),
      [200],
    );
    expect(unpublished.body.missing).toStrictEqual(hashes);
    const retry = await accept(
      api().publishBatch({ headers: publisher, body: { manifests } }),
      [200],
    );
    expect(retry.body.hashes).toStrictEqual(hashes);
    const published = await accept(
      api().publishStatus({ headers: publisher, body: { hashes } }),
      [200],
    );
    expect(published.body.missing).toStrictEqual([]);
  });

  it("publishes a batch that references an already public file", async () => {
    const file = await accept(
      api().publishFile({
        headers: publisher,
        body: {
          filename: "preset.txt",
          contentType: "text/plain",
          data: Buffer.from(taskId).toString("base64"),
        },
      }),
      [200],
    );
    const body = { ...manifest(), files: [file.body] };
    const batch = await accept(
      api().publishBatch({ headers: publisher, body: { manifests: [body] } }),
      [200],
    );
    await enableActor();
    const resolved = await accept(
      api().resolve({
        headers: auth,
        extraHeaders: { origin },
        params: { hash: batch.body.hashes[0]! },
        body: {},
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual(body);
  });

  it("rejects a batch manifest larger than the reader's individual object limit", async () => {
    const body = {
      ...manifest("\u0000".repeat(20_000)),
      options: { showcase: "\u0000".repeat(2048) },
    };
    expect(
      (
        await api().publishBatch({
          headers: publisher,
          body: { manifests: [body] },
        })
      ).status,
    ).toBe(400);
  });

  it("bounds publisher inventory and write batches", async () => {
    const hash = "a".repeat(64);
    expect(
      (
        await api().publishStatus({
          headers: publisher,
          body: {
            hashes: Array.from({ length: 501 }, () => {
              return hash;
            }),
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api().publishBatch({
          headers: publisher,
          body: {
            manifests: Array.from({ length: 101 }, () => {
              return manifest();
            }),
          },
        })
      ).status,
    ).toBe(400);
  });

  it("still rejects missing handoff credentials after the transport is initialized", async () => {
    await accept(
      api().publish({
        headers: publisher,
        body: manifest("Initialize transport"),
      }),
      [200],
    );
    mockEnv("R2_MARKETING_HANDOFF_ACCESS_KEY_ID", undefined);
    await accept(
      api().publish({
        headers: publisher,
        body: manifest("Missing credentials"),
      }),
      [500],
    );
    expect(context.mocks.s3.clientConfig).toHaveBeenCalledTimes(1);
  });

  it("allows a trusted published preset to be used repeatedly across accounts", async () => {
    const published = await accept(
      api().publish({ headers: publisher, body: manifest() }),
      [200],
    );
    expect(
      (
        await api().resolve({
          params: published.body,
          body: {},
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(200);
    await enableActor();
    expect(
      (
        await api().resolve({
          params: published.body,
          body: {},
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(200);
  });

  it("does not let an enabled browser session publish public content", async () => {
    expect(
      (
        await api().publish({
          headers: auth,
          body: manifest(),
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(403);
  });

  it("transfers a guest grant to the signed-in user rather than exposing it to the next account", async () => {
    const cookie = await guestCookie();
    const created = await create(manifest(), cookie, false);
    expect(
      (
        await api().resolve({
          params: created.body,
          body: {},
          headers: auth,
          extraHeaders: { origin, cookie },
        })
      ).status,
    ).toBe(200);
    await enableActor();
    expect(
      (
        await api().resolve({
          params: created.body,
          body: {},
          headers: auth,
          extraHeaders: { origin, cookie },
        })
      ).status,
    ).toBe(404);
  });

  it("rejects a tampered guest session", async () => {
    const cookie = await guestCookie();
    const created = await create(manifest(), cookie, false);
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a");
    expect(
      (
        await api().resolve({
          params: created.body,
          body: {},
          headers: auth,
          extraHeaders: { origin, cookie: tampered },
        })
      ).status,
    ).toBe(404);
  });

  it("atomically transfers a guest grant when two accounts try to receive it concurrently", async () => {
    const firstActor = actor;
    const cookie = await guestCookie();
    const created = await create(manifest(), cookie, false);
    const secondActor = await enableActor();
    context.mocks.clerk.authenticateRequest.mockImplementation(
      (request: unknown) => {
        if (!(request instanceof Request)) {
          throw new Error("Expected an authentication request");
        }
        const identity =
          request.headers.get("authorization") === "Bearer handoff-a"
            ? firstActor
            : secondActor;
        return Promise.resolve({
          isAuthenticated: true,
          toAuth: () => {
            return { ...identity, orgRole: "org:admin" };
          },
        });
      },
    );
    const attempts = await Promise.all(
      ["handoff-a", "handoff-b"].map((token) => {
        return api().resolve({
          params: created.body,
          body: {},
          headers: { authorization: `Bearer ${token}` },
          extraHeaders: { origin, cookie },
        });
      }),
    );
    expect(
      attempts
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([200, 404]);
  });

  it("keeps guest-uploaded files authorized after sign-in and prompt editing", async () => {
    const cookie = await guestCookie();
    const uploaded = await accept(
      api().upload({
        body: {
          filename: "guest.txt",
          contentType: "text/plain",
          data: Buffer.from("guest bytes").toString("base64"),
        },
        extraHeaders: { origin, cookie },
      }),
      [200],
    );
    const original = await create(
      { ...manifest(), files: [uploaded.body] },
      cookie,
      false,
    );
    await accept(
      api().resolve({
        params: original.body,
        body: {},
        headers: auth,
        extraHeaders: { origin, cookie },
      }),
      [200],
    );
    const edited = await create({
      ...manifest("Edited after signing in"),
      files: [uploaded.body],
    });
    expect(edited.body.hash).not.toBe(original.body.hash);
    expect(
      (
        await api().import({
          params: edited.body,
          body: { intentId },
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(200);
  });

  it("cannot attach another account's file by hash", async () => {
    const file = await accept(
      api().upload({
        body: {
          filename: "notes.txt",
          contentType: "text/plain",
          data: Buffer.from("private notes").toString("base64"),
        },
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    await enableActor();
    expect(
      (
        await api().create({
          body: { ...manifest(), files: [file.body] },
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(404);
  });

  it("imports files privately with stable identities on retry", async () => {
    const uploaded = await accept(
      api().upload({
        body: {
          filename: "notes.txt",
          contentType: "text/plain",
          data: Buffer.from("private notes").toString("base64"),
        },
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    const created = await create({ ...manifest(), files: [uploaded.body] });
    const first = await accept(
      api().import({
        params: created.body,
        body: { intentId },
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    const retry = await accept(
      api().import({
        params: { hash: created.body.shortHash },
        body: { intentId },
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    expect(retry.body).toStrictEqual(first.body);
    const anotherUse = await accept(
      api().import({
        params: created.body,
        body: { intentId: randomUUID() },
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    expect(anotherUse.body.files[0]?.id).not.toBe(first.body.files[0]?.id);
    expect(first.body.files).toHaveLength(1);
    const file = first.body.files[0]!;
    expect(file.filename).toBe("notes.txt");
    const fileClient = setupApp({ context, routes })(webFilesContract);
    expect(
      (await fileClient.fileUrl({ query: { file_id: file.id }, headers: auth }))
        .status,
    ).toBe(200);
    await enableActor();
    expect(
      (await fileClient.fileUrl({ query: { file_id: file.id }, headers: auth }))
        .status,
    ).toBe(404);
  });

  it("rejects a manifest whose declared size differs from uploaded bytes", async () => {
    const uploaded = await accept(
      api().upload({
        body: {
          filename: "notes.txt",
          contentType: "text/plain",
          data: Buffer.from("private notes").toString("base64"),
        },
        headers: auth,
        extraHeaders: { origin },
      }),
      [200],
    );
    expect(
      (
        await api().create({
          body: { ...manifest(), files: [{ ...uploaded.body, size: 1 }] },
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(400);
  });

  it("honors the server switch on reads and writes", async () => {
    const created = await create();
    await updateFeatureSwitchesForUser(context, actor, {
      marketingContentHandoff: false,
    });
    expect(
      (
        await accept(
          api().config({ headers: auth, extraHeaders: { origin } }),
          [200],
        )
      ).body.enabled,
    ).toBeFalsy();
    expect(
      (
        await api().create({
          body: manifest(),
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api().resolve({
          params: created.body,
          body: {},
          headers: auth,
          extraHeaders: { origin },
        })
      ).status,
    ).toBe(403);
  });

  it("rejects requests from another origin even when the user is enabled", async () => {
    expect(
      (
        await api().create({
          body: manifest(),
          headers: auth,
          extraHeaders: { origin: "https://untrusted.example" },
        })
      ).status,
    ).toBe(403);
  });
});
