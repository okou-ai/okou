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
  it("creates, reads, edits and clears exact text while object storage is unavailable", async () => {
    context.mocks.s3.send.mockRejectedValue(
      new Error("Object storage is unavailable"),
    );
    const fixture = await instructionFixture();
    await expect(fixture.content()).resolves.toBe("");
    const raw = "\uFEFF  First line\r\n中文\n\n  ";
    await fixture.update(raw);
    await expect(fixture.content()).resolves.toBe(raw);
    await fixture.update("");
    await expect(fixture.content()).resolves.toBe("");
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
