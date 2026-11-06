import {
  contentBundleDigest,
  readContentBundle,
} from "@okouai/core/content-bundle";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentInstructionsRoutes } from "../agent-instructions";
import { agentsRoutes } from "../agents";
import { createRouteMocks } from "./helpers/route-test";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

async function instructionFixture(visibility: "public" | "private" = "public") {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, "org:admin");
  const app = await setupApp({
    context,
    routes: [...agentsRoutes, ...agentInstructionsRoutes],
    rethrowErrors: false,
  });
  const instructions = app(agentInstructionsContract);
  const collection = app(agentsMainContract);
  const agent = await accept(
    collection.create({
      headers,
      body: { displayName: "Database instructions", visibility },
    }),
    [201],
  );
  const params = { id: agent.body.agentId };
  return {
    instructions,
    collection,
    params,
    orgId,
    userId,
    agents: app(agentsByIdContract),
    async content() {
      const result = await accept(instructions.get({ headers, params }), [200]);
      return result.body.content;
    },
    async update(content: string) {
      return await accept(
        instructions.update({ headers, params, body: { content } }),
        [200],
      );
    },
  };
}

describe("Agent database instructions", () => {
  it("invalidates organization editors without publishing private instruction data", async () => {
    const fixture = await instructionFixture("private");
    await fixture.update("Private instructions");
    await flushWaitUntilForTest();
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `org:${fixture.orgId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "agentInstructionsChanged",
      null,
    );
    await expect(fixture.content()).resolves.toBe("Private instructions");
  });

  it("keeps a newer edit when the editor submits an outdated baseline", async () => {
    const fixture = await instructionFixture();
    await fixture.update("Original instructions");
    const baseline = await fixture.content();
    await fixture.update("Newer instructions");
    await accept(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "Outdated draft", ifContent: baseline },
      }),
      [409],
    );
    await expect(fixture.content()).resolves.toBe("Newer instructions");
    await accept(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "Reviewed edit", ifContent: "Newer instructions" },
      }),
      [200],
    );
    await expect(fixture.content()).resolves.toBe("Reviewed edit");
  });

  it.each([
    { operation: "lookup", command: HeadObjectCommand },
    { operation: "upload", command: PutObjectCommand },
  ])(
    "preserves public state when package $operation fails",
    async ({ command }) => {
      installWorkflowVolumeS3Fixture(context);
      const send = context.mocks.s3.send.getMockImplementation();
      if (!send) {
        throw new Error("Expected the S3 fixture");
      }
      let unavailable = true;
      context.mocks.s3.send.mockImplementation((request: unknown, ...args) => {
        if (unavailable && request instanceof command) {
          return Promise.reject(
            Object.assign(
              new Error(
                "Reduce your concurrent request rate for the same object.",
              ),
              {
                name: "ServiceUnavailable",
                $metadata: { httpStatusCode: 429 },
              },
            ),
          );
        }
        return send(request, ...args);
      });
      await expect(instructionFixture()).rejects.toThrow("500");
      const collection = setupApp({ context, routes: agentsRoutes })(
        agentsMainContract,
      );
      const failedCreation = await accept(collection.list({ headers }), [200]);
      expect(failedCreation.body).toStrictEqual([]);

      unavailable = false;
      const fixture = await instructionFixture();
      const raw = "\uFEFF  First line\r\n中文\n\n  ";
      await fixture.update(raw);
      unavailable = true;
      await expect(
        fixture.instructions.update({
          headers,
          params: fixture.params,
          body: { content: "Unpublished edit" },
        }),
      ).rejects.toThrow("500");
      await expect(fixture.content()).resolves.toBe(raw);
      unavailable = false;
      await fixture.update("Recovered edit");
      await expect(fixture.content()).resolves.toBe("Recovered edit");
    },
  );

  it("does not create an Agent when its bundle lookup is cancelled", async () => {
    installWorkflowVolumeS3Fixture(context);
    const send = context.mocks.s3.send.getMockImplementation();
    if (!send) {
      throw new Error("Expected the S3 fixture");
    }
    const owner = new AbortController();
    const reason = new DOMException("Agent creation cancelled", "AbortError");
    context.mocks.s3.send.mockImplementation((request: unknown, ...args) => {
      if (request instanceof HeadObjectCommand) {
        const options = args[0];
        if (
          typeof options !== "object" ||
          options === null ||
          !("abortSignal" in options) ||
          !(options.abortSignal instanceof AbortSignal)
        ) {
          throw new Error("Expected a cancellable bundle lookup");
        }
        const lookup = createDeferredPromise<void>(options.abortSignal);
        owner.abort(reason);
        return lookup.promise;
      }
      return send(request, ...args);
    });
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );
    const collection = setupApp({
      context,
      routes: agentsRoutes,
      signal: AbortSignal.any([context.signal, owner.signal]),
      rethrowErrors: true,
    })(agentsMainContract);
    await expect(collection.create({ headers, body: {} })).rejects.toBe(reason);
    const accepted = await accept(
      setupApp({ context, routes: agentsRoutes })(agentsMainContract).list({
        headers,
      }),
      [200],
    );
    expect(accepted.body).toStrictEqual([]);
  });

  it("publishes exact text and explicit empty overwrite", async () => {
    const fixture = await instructionFixture();
    const raw = "\uFEFF  First line\r\n中文\n\n  ";
    await fixture.update(raw);
    await expect(fixture.content()).resolves.toBe(raw);
    await fixture.update("");
    await expect(fixture.content()).resolves.toBe("");
  });

  it("keeps a coherent accepted edit under concurrent publication", async () => {
    const fixture = await instructionFixture();
    const baseline = await fixture.content();
    const results = await Promise.all(
      ["First edit", "Second edit"].map((content) => {
        return accept(
          fixture.instructions.update({
            headers,
            params: fixture.params,
            body: { content, ifContent: baseline },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const current = await fixture.content();
    expect(["First edit", "Second edit"]).toContain(current);
    await fixture.update("After both commits");
    await expect(fixture.content()).resolves.toBe("After both commits");
  });

  it("publishes owner-independent immutable packages containing the exact accepted text", async () => {
    const objects = new Map<string, Buffer>();
    const storage = installWorkflowVolumeS3Fixture(context, objects);
    const send = context.mocks.s3.send.getMockImplementation();
    if (!send) {
      throw new Error("Expected the S3 fixture");
    }
    // R2 rejects repeated writes to the same hot object. Even conditional PUTs
    // must be avoided on the already-published path.
    context.mocks.s3.send.mockImplementation((request: unknown, ...args) => {
      if (
        request instanceof PutObjectCommand &&
        objects.has(request.input.Key ?? "")
      ) {
        return Promise.reject(
          Object.assign(
            new Error(
              "Reduce your concurrent request rate for the same object.",
            ),
            {
              name: "ServiceUnavailable",
              $metadata: { httpStatusCode: 429 },
            },
          ),
        );
      }
      return send(request, ...args);
    });
    const first = await instructionFixture();
    const body = "\uFEFF raw instructions\r\n中文  ";
    await first.update(body);
    const second = await instructionFixture();
    await second.update(body);
    await second.update(body);
    await second.update("");
    await expect(second.content()).resolves.toBe("");
    await second.update(body);
    const packages = [...objects].filter(([key]) => {
      return key.startsWith("bundles/v1/");
    });
    const matching = packages
      .flatMap(([key, archive]) => {
        const sha256 = contentBundleDigest(archive);
        expect(key).toBe(`bundles/v1/${sha256}.tar.gz`);
        return readContentBundle(archive, {
          sha256,
          archiveBytes: archive.length,
        });
      })
      .filter((file) => {
        return file.content.equals(Buffer.from(body));
      });
    expect(
      matching.map((file) => {
        return file.path;
      }),
    ).toStrictEqual(["instructions.md"]);
    expect(storage.writes).toHaveLength(2);
    for (const [request] of context.mocks.s3.send.mock.calls) {
      if (request instanceof PutObjectCommand) {
        expect(request.input).toMatchObject({
          IfNoneMatch: "*",
          CacheControl: "public, max-age=31536000, immutable",
        });
      }
    }
    await expect(second.content()).resolves.toBe(body);
  });

  it("reuses the winning bundle when independent Agent creations race", async () => {
    const storage = installWorkflowVolumeS3Fixture(context);
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    function releaseWrite() {
      if (!release.settled()) {
        release.resolve();
      }
    }
    const owner = createFixtureOperationOwner(
      () => {
        return Promise.resolve();
      },
      { beforeDrain: releaseWrite },
    );
    storage.beforeNextBundleWrite(async () => {
      started.resolve();
      await release.promise;
    });
    const pending = settleIncludingAbort(owner.run(instructionFixture));
    const secondResult = await settleIncludingAbort(async () => {
      const early = await Promise.race([started.promise, pending]);
      if (early !== undefined) {
        if (!early.ok) {
          throw early.error;
        }
        throw new Error("Agent creation finished before bundle publication");
      }
      return await owner.run(instructionFixture);
    });
    releaseWrite();
    const first = await pending;
    if (!first.ok) {
      throw first.error;
    }
    if (!secondResult.ok) {
      throw secondResult.error;
    }
    const second = secondResult.value;
    expect(first.value.params.id).not.toBe(second.params.id);
    mocks.clerk.session(first.value.userId, first.value.orgId, "org:admin");
    await expect(first.value.content()).resolves.toBe("");
    mocks.clerk.session(second.userId, second.orgId, "org:admin");
    await expect(second.content()).resolves.toBe("");
    expect(storage.writes).toHaveLength(1);
  });

  it("rejects NUL text and preserves the current body", async () => {
    const fixture = await instructionFixture();
    await fixture.update("Current instructions");
    await accept(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "invalid\0body" },
      }),
      [400],
    );
    await expect(fixture.content()).resolves.toBe("Current instructions");
  });

  it("keeps legacy profile stripping in the editor presentation", async () => {
    const fixture = await instructionFixture();
    await fixture.update(
      "[AGENT_PROFILE]\nLegacy profile\n[/AGENT_PROFILE]\n  Body for editing  ",
    );
    await expect(fixture.content()).resolves.toBe("Body for editing");
    await accept(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "Edited body", ifContent: "Body for editing" },
      }),
      [200],
    );
    await expect(fixture.content()).resolves.toBe("Edited body");
  });

  it("preserves profile fields when updating instructions", async () => {
    const fixture = await instructionFixture();
    await accept(
      fixture.agents.updateMetadata({
        headers,
        params: fixture.params,
        body: {
          displayName: "Edited profile",
          description: "Kept description",
        },
      }),
      [200],
    );
    const updated = await fixture.update("Edited instructions");
    expect(updated.body).toMatchObject({
      displayName: "Edited profile",
      description: "Kept description",
    });
    await expect(fixture.content()).resolves.toBe("Edited instructions");
  });

  it("allows public reads and admin edits, but refuses ordinary member writes and foreign tenants", async () => {
    const fixture = await instructionFixture();
    await fixture.update("Owner instructions");
    const other = `user_${randomUUID()}`;
    mocks.clerk.session(other, fixture.orgId, "org:member");
    await expect(fixture.content()).resolves.toBe("Owner instructions");
    await accept(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "Denied" },
      }),
      [403],
    );
    mocks.clerk.session(other, fixture.orgId, "org:admin");
    await fixture.update("Admin instructions");
    mocks.clerk.session(other, `org_${randomUUID()}`, "org:admin");
    await accept(
      fixture.instructions.get({ headers, params: fixture.params }),
      [404],
    );
    await accept(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "Foreign" },
      }),
      [404],
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    await expect(fixture.content()).resolves.toBe("Admin instructions");
    await fixture.update("Owner still allowed");
  });

  it("keeps private instructions owner-only, including an org admin", async () => {
    const fixture = await instructionFixture("private");
    await fixture.update("Private instructions");
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:admin");
    await accept(
      fixture.instructions.get({ headers, params: fixture.params }),
      [404],
    );
    await accept(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "Denied" },
      }),
      [403],
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    await expect(fixture.content()).resolves.toBe("Private instructions");
  });

  it("cannot recreate deleted instructions", async () => {
    const fixture = await instructionFixture();
    await accept(
      fixture.agents.delete({ headers, params: fixture.params }),
      [204],
    );
    const missing = await accept(
      fixture.instructions.get({ headers, params: fixture.params }),
      [404],
    );
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    await accept(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "Deleted" },
      }),
      [404],
    );
  });
});
