import {
  contentBundleDigest,
  readContentBundle,
} from "@okouai/core/content-bundle";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
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
  it("preserves the accepted body when package publication fails", async () => {
    const fixture = await instructionFixture();
    const raw = "\uFEFF  First line\r\n中文\n\n  ";
    await fixture.update(raw);
    context.mocks.s3.send.mockRejectedValue(
      new Error("Object storage is unavailable"),
    );
    await expect(
      fixture.instructions.update({
        headers,
        params: fixture.params,
        body: { content: "Unpublished edit" },
      }),
    ).rejects.toThrow("500");
    await expect(fixture.content()).resolves.toBe(raw);
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
    const results = await Promise.all(
      ["First edit", "Second edit"].map((content) => {
        return accept(
          fixture.instructions.update({
            headers,
            params: fixture.params,
            body: { content },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      results.some((result) => {
        return result.status === 200;
      }),
    ).toBeTruthy();
    const current = await fixture.content();
    expect(["First edit", "Second edit"]).toContain(current);
    await fixture.update("After both commits");
    await expect(fixture.content()).resolves.toBe("After both commits");
  });

  it("publishes owner-independent immutable packages containing the exact accepted text", async () => {
    const objects = new Map<string, Buffer>();
    installWorkflowVolumeS3Fixture(context, objects);
    const first = await instructionFixture();
    const body = "\uFEFF raw instructions\r\n中文  ";
    await first.update(body);
    const second = await instructionFixture();
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
    await expect(second.content()).resolves.toBe(body);
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
