import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { workflowsRoutes } from "../workflows";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);

function installObjectStore() {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((request: unknown) => {
    if (request instanceof PutObjectCommand) {
      const { Key: key, Body: body } = request.input;
      if (!key || !(typeof body === "string" || body instanceof Uint8Array)) {
        throw new Error("Expected a Storage object");
      }
      objects.set(key, Buffer.from(body));
      return Promise.resolve({});
    }
    if (
      request instanceof GetObjectCommand ||
      request instanceof HeadObjectCommand
    ) {
      const body = request.input.Key
        ? objects.get(request.input.Key)
        : undefined;
      if (!body) {
        return Promise.reject(
          Object.assign(new Error("Missing object"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: body.length,
        Body: Readable.from([body]),
      });
    }
    return Promise.resolve({});
  });
}

function detailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

async function createVolume() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Ready index owner",
  });
  installObjectStore();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const definition = {
    name: `index-reuse-${randomUUID().slice(0, 8)}`,
    description: "Canonical indexed workflow resources",
    instruction: "Keep the first exact revision.",
  };
  const files = [
    { path: "./AGENTS.md", content: "Normalized instructions" },
    { path: "AGENTS.md", content: "Canonical instructions: 世界" },
    { path: "notes.txt", content: "First duplicate" },
    { path: "notes.txt", content: "Last duplicate" },
    { path: "assets/icon.txt", content: "Non-discovery asset" },
  ];
  const created = await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsCollectionContract,
    ).create({
      headers,
      body: { agentId: agent.agentId, ...definition, files },
    }),
    [201],
  );
  const workflowId = created.body.id;
  const read = () => {
    return accept(
      detailClient().get({ headers, params: { workflowId } }),
      [200],
    );
  };
  const update = (
    instruction = definition.instruction,
    attachedFiles = files,
  ) => {
    return detailClient().update({
      headers,
      params: { workflowId },
      body: { instruction, files: attachedFiles },
    });
  };
  const original = await read();
  return { definition, files, read, update, original };
}

describe("Workflow canonical content", () => {
  it("publishes A-B-A with exact canonical content", async () => {
    const volume = await createVolume();
    const secondInstruction = "Publish the second exact revision.";
    await accept(volume.update(secondInstruction), [200]);
    expect((await volume.read()).body.instruction).toBe(secondInstruction);

    context.mocks.s3.send.mockClear();
    await accept(
      volume.update(volume.definition.instruction, [...volume.files].reverse()),
      [200],
    );
    expect((await volume.read()).body).toMatchObject({
      instruction: volume.definition.instruction,
      fileContents: volume.original.body.fileContents,
    });
    expect(
      context.mocks.s3.send.mock.calls.some(([request]) => {
        return (
          request instanceof PutObjectCommand ||
          request instanceof HeadObjectCommand
        );
      }),
    ).toBeFalsy();
  });
});
