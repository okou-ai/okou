import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentInstructionsRoutes } from "../agent-instructions";
import { agentsRoutes } from "../agents";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function clients(signal?: AbortSignal) {
  const app = setupApp({
    context,
    routes: [...agentsRoutes, ...agentInstructionsRoutes],
    rethrowErrors: true,
    ...(signal ? { signal } : {}),
  });
  return {
    instructions: app(agentInstructionsContract),
    agents: app(agentsByIdContract),
    collection: app(agentsMainContract),
  };
}

function uploadPause() {
  const entered = createDeferredPromise<void>(context.signal);
  const receipt = createDeferredPromise<Error | undefined>(context.signal);
  const release = () => {
    if (!receipt.settled()) {
      receipt.resolve(undefined);
    }
  };
  onTestFinished(release);
  return {
    entered: entered.promise,
    release,
    fail(error: Error): void {
      receipt.resolve(error);
    },
    async wait(): Promise<void> {
      entered.resolve();
      const error = await receipt.promise;
      if (error) {
        throw error;
      }
    },
  };
}

async function instructionFixture(
  afterWrite?: (command: PutObjectCommand) => Promise<void>,
) {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, "org:admin");
  installDurableUserExportStorage(context, {
    prefixes: [`${orgId}/`],
    afterWrite: async (command) => {
      if (command instanceof PutObjectCommand) {
        await afterWrite?.(command);
      }
    },
  });
  const api = clients();
  const agent = await accept(
    api.collection.create({
      headers,
      body: { displayName: "Instruction publication", visibility: "public" },
    }),
    [201],
  );
  const params = { id: agent.body.agentId };
  return {
    api,
    params,
    orgId,
    userId,
    async content(): Promise<string | null> {
      const result = await accept(
        api.instructions.get({ headers, params }),
        [200],
      );
      return result.body.content;
    },
    async update(content: string) {
      return await accept(
        api.instructions.update({ headers, params, body: { content } }),
        [200],
      );
    },
  };
}

function isArchive(command: PutObjectCommand): boolean {
  return command.input.Key?.endsWith("/archive.tar.gz") === true;
}

describe("Agent instruction preparation and publication", () => {
  it("keeps empty instructions readable and reuses registered content without remote writes", async () => {
    const fixture = await instructionFixture();
    await expect(fixture.content()).resolves.toBe("");
    for (const content of ["Version A", "Version B"]) {
      await fixture.update(content);
      await expect(fixture.content()).resolves.toBe(content);
    }
    context.mocks.s3.send.mockClear();
    await fixture.update("Version A");
    const commands = context.mocks.s3.send.mock.calls.map(([command]) => {
      return command instanceof Object ? command.constructor.name : "";
    });
    expect(commands).not.toContain("PutObjectCommand");
    expect(commands).not.toContain("HeadObjectCommand");
    await expect(fixture.content()).resolves.toBe("Version A");
  });

  it("lets a newer publication finish while an older upload is blocked and rejects the older write", async () => {
    const pause = uploadPause();
    let blocked = false;
    const fixture = await instructionFixture(async (command) => {
      if (blocked && isArchive(command)) {
        blocked = false;
        await pause.wait();
      }
    });
    blocked = true;
    const older = fixture.api.instructions.update({
      headers,
      params: fixture.params,
      body: { content: "Slow old instructions" },
    });
    onTestFinished(async () => {
      pause.release();
      await Promise.allSettled([older]);
    });
    await pause.entered;
    await fixture.update("New published instructions");
    await expect(fixture.content()).resolves.toBe("New published instructions");
    pause.release();
    const response = await accept(older, [409]);
    expect(response.body.error.code).toBe("CONFLICT");
    await expect(fixture.content()).resolves.toBe("New published instructions");
  });

  it("does not settle a newer pending token when an older upload fails", async () => {
    const olderPause = uploadPause();
    const newerPause = uploadPause();
    const pauses: ReturnType<typeof uploadPause>[] = [];
    const fixture = await instructionFixture(async (command) => {
      if (isArchive(command)) {
        await pauses.shift()?.wait();
      }
    });
    await fixture.update("Previously published instructions");
    pauses.push(olderPause, newerPause);
    const older = fixture.api.instructions.update({
      headers,
      params: fixture.params,
      body: { content: "Failed older instructions" },
    });
    const olderResult = settleIncludingAbort(older);
    await olderPause.entered;
    const newer = fixture.api.instructions.update({
      headers,
      params: fixture.params,
      body: { content: "New pending instructions" },
    });
    onTestFinished(async () => {
      olderPause.release();
      newerPause.release();
      await Promise.allSettled([older, newer, olderResult]);
    });
    await newerPause.entered;
    olderPause.fail(new Error("Older upload failed"));
    await expect(olderResult).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: "Older upload failed" }),
    });
    await expect(fixture.content()).resolves.toBe(
      "Previously published instructions",
    );
    newerPause.release();
    await accept(newer, [200]);
    await expect(fixture.content()).resolves.toBe("New pending instructions");
  });

  it.each(["archive.tar.gz", "manifest.json"])(
    "keeps the previous HEAD after a failed %s receipt and permits retry",
    async (filename) => {
      let failedKey: string | undefined;
      const fixture = await instructionFixture((command) => {
        if (command.input.Key?.endsWith(`/${failedKey}`)) {
          failedKey = undefined;
          return Promise.reject(new Error("Instruction upload failed"));
        }
        return Promise.resolve();
      });
      await fixture.update("Committed instructions");
      failedKey = filename;
      await expect(
        fixture.api.instructions.update({
          headers,
          params: fixture.params,
          body: { content: "Uncommitted instructions" },
        }),
      ).rejects.toThrow("Instruction upload failed");
      await expect(fixture.content()).resolves.toBe("Committed instructions");
      await fixture.update("Uncommitted instructions");
      await expect(fixture.content()).resolves.toBe("Uncommitted instructions");
    },
  );

  it("allows profile mutation during upload and preserves its latest metadata", async () => {
    const pause = uploadPause();
    let blocked = false;
    const fixture = await instructionFixture(async (command) => {
      if (blocked && isArchive(command)) {
        blocked = false;
        await pause.wait();
      }
    });
    blocked = true;
    const updating = fixture.api.instructions.update({
      headers,
      params: fixture.params,
      body: { content: "Prepared instructions" },
    });
    onTestFinished(async () => {
      pause.release();
      await Promise.allSettled([updating]);
    });
    await pause.entered;
    await accept(
      fixture.api.agents.updateMetadata({
        headers,
        params: fixture.params,
        body: { displayName: "Changed during upload" },
      }),
      [200],
    );
    pause.release();
    const updated = await accept(updating, [200]);
    expect(updated.body.displayName).toBe("Changed during upload");
    await expect(fixture.content()).resolves.toBe("Prepared instructions");
  });

  it("rechecks visibility and rejects a now-unauthorized admin after upload", async () => {
    const pause = uploadPause();
    let blocked = false;
    const fixture = await instructionFixture(async (command) => {
      if (blocked && isArchive(command)) {
        blocked = false;
        await pause.wait();
      }
    });
    await fixture.update("Owner instructions");
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:admin");
    blocked = true;
    const updating = fixture.api.instructions.update({
      headers,
      params: fixture.params,
      body: { content: "Admin prepared instructions" },
    });
    onTestFinished(async () => {
      pause.release();
      await Promise.allSettled([updating]);
    });
    await pause.entered;
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    await accept(
      fixture.api.agents.updateMetadata({
        headers,
        params: fixture.params,
        body: { visibility: "private" },
      }),
      [200],
    );
    pause.release();
    const rejected = await accept(updating, [403]);
    expect(rejected.body.error.code).toBe("FORBIDDEN");
    await expect(fixture.content()).resolves.toBe("Owner instructions");
    await fixture.update("New owner instructions");
    await expect(fixture.content()).resolves.toBe("New owner instructions");
  });

  it("does not recreate deleted Agent instructions when an upload finishes late", async () => {
    const pause = uploadPause();
    let blocked = false;
    const fixture = await instructionFixture(async (command) => {
      if (blocked && isArchive(command)) {
        blocked = false;
        await pause.wait();
      }
    });
    blocked = true;
    const updating = fixture.api.instructions.update({
      headers,
      params: fixture.params,
      body: { content: "Late deleted instructions" },
    });
    onTestFinished(async () => {
      pause.release();
      await Promise.allSettled([updating]);
    });
    await pause.entered;
    await accept(
      fixture.api.agents.delete({ headers, params: fixture.params }),
      [204],
    );
    pause.release();
    await accept(updating, [404]);
    await accept(
      fixture.api.instructions.get({ headers, params: fixture.params }),
      [404],
    );
    const listed = await accept(
      fixture.api.collection.list({ headers }),
      [200],
    );
    expect(listed.body).toStrictEqual([]);
  });

  it("settles cancelled preparation without changing the published instructions", async () => {
    const pause = uploadPause();
    let blocked = false;
    const fixture = await instructionFixture(async (command) => {
      if (blocked && isArchive(command)) {
        blocked = false;
        await pause.wait();
      }
    });
    await fixture.update("Instructions before cancellation");
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
    });
    const cancelledApi = clients(
      AbortSignal.any([context.signal, controller.signal]),
    );
    blocked = true;
    const updating = cancelledApi.instructions.update({
      headers,
      params: fixture.params,
      body: { content: "Cancelled instructions" },
    });
    const cancelledResult = settleIncludingAbort(updating);
    onTestFinished(async () => {
      pause.release();
      await Promise.allSettled([updating, cancelledResult]);
    });
    await pause.entered;
    controller.abort(new DOMException("Request cancelled", "AbortError"));
    pause.release();
    await expect(cancelledResult).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({ name: "AbortError" }),
    });
    await expect(fixture.content()).resolves.toBe(
      "Instructions before cancellation",
    );
    await fixture.update("Instructions after cancellation");
    await expect(fixture.content()).resolves.toBe(
      "Instructions after cancellation",
    );
  });
});
