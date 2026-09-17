import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const workflows = createWorkflowsBddApi(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
function headers() {
  return { authorization: "Bearer clerk-session" };
}

function detailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function automationClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function installVolumeStorage() {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      return Promise.resolve({
        Contents: [...objects.keys()]
          .filter((key) => {
            return key.startsWith(command.input.Prefix ?? "");
          })
          .map((Key) => {
            return { Key };
          }),
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key) {
          objects.delete(object.Key);
        }
      }
      return Promise.resolve({});
    }
    if (
      !(
        command instanceof PutObjectCommand ||
        command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand
      ) ||
      !command.input.Key
    ) {
      throw new Error("Unexpected volume storage command");
    }
    const key = command.input.Key;
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body;
      if (!(typeof body === "string" || body instanceof Uint8Array)) {
        throw new Error("Expected volume bytes");
      }
      objects.set(key, Buffer.from(body));
      return Promise.resolve({});
    }
    const body = objects.get(key);
    if (!body) {
      throw Object.assign(new Error("Missing object"), { name: "NoSuchKey" });
    }
    return Promise.resolve({
      ContentLength: body.length,
      Body: Readable.from([body]),
    });
  });
}

async function scenario() {
  const { actor } = await workflows.setupWorkflowOrg({ tier: "team" });
  const source = await workflows.createAgent(actor);
  const target = await workflows.createAgent(actor);
  installVolumeStorage();
  const workflow = await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsCollectionContract,
    ).create({
      headers: headers(),
      body: {
        agentId: source.agentId,
        name: "copy-lock-source",
        instruction: "Original instruction",
        files: [
          { path: "references/context.md", content: "Original attachment" },
        ],
      },
    }),
    [201],
  );
  const workflowId = workflow.body.id;
  const automation = await accept(
    automationClient().create({
      headers: headers(),
      params: { workflowId },
      body: { kind: "event", eventType: "webhook-received" },
    }),
    [201],
  );
  const thread = await chat.createThread(actor, {
    agentId: source.agentId,
    title: "Unrelated thread",
  });
  return {
    actor,
    source,
    target,
    workflowId,
    automation: automation.body,
    thread,
  };
}

function holdPreparation(phase: "KMS" | "upload") {
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  if (phase === "KMS") {
    useSecretKmsProbe((request, callNumber) => {
      if (callNumber !== 1) {
        return undefined;
      }
      return (async () => {
        entered.resolve();
        await released.promise;
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
          encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
        };
      })();
    });
  } else {
    const send = context.mocks.s3.send.getMockImplementation();
    if (!send) {
      throw new Error("Expected configured object storage");
    }
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        if (!entered.settled()) {
          entered.resolve();
        }
        await released.promise;
      }
      return await send(command);
    });
  }
  return {
    entered: entered.promise,
    release: () => {
      if (!released.settled()) {
        released.resolve();
      }
    },
  };
}

function startCopy(
  args: Awaited<ReturnType<typeof scenario>>,
  gate: ReturnType<typeof holdPreparation>,
) {
  const copying = detailClient().copy({
    headers: headers(),
    params: { workflowId: args.workflowId },
    body: { toAgentId: args.target.agentId },
  });
  const settled = settleIncludingAbort(copying);
  onTestFinished(async () => {
    gate.release();
    await settled;
  });
  return copying;
}

async function expectNoCopy(targetAgentId: string) {
  const listed = await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsCollectionContract,
    ).list({ headers: headers(), query: { agentId: targetAgentId } }),
    [200],
  );
  expect(listed.body).toStrictEqual([]);
  const automations = await accept(
    automationClient().listWorkspace({ headers: headers() }),
    [200],
  );
  expect(
    automations.body.some((automation) => {
      return automation.workflow.agentId === targetAgentId;
    }),
  ).toBeFalsy();
}

describe("workflow copy preparation lock isolation", () => {
  it.each(["KMS", "upload"] as const)(
    "allows unrelated thread writes while %s is stalled and publishes a complete copy",
    async (phase) => {
      const args = await scenario();
      const gate = holdPreparation(phase);
      const copying = startCopy(args, gate);
      await gate.entered;
      await chat.renameThread(
        args.actor,
        args.thread.id,
        "Changed during copy",
      );
      await expect(
        chat.readThreadMetadata(args.actor, args.thread.id),
      ).resolves.toMatchObject({
        id: args.thread.id,
        title: "Changed during copy",
      });
      await expectNoCopy(args.target.agentId);
      gate.release();
      const copied = await accept(copying, [201]);
      const detail = await accept(
        detailClient().get({
          headers: headers(),
          params: { workflowId: copied.body.id },
        }),
        [200],
      );
      expect(detail.body.instruction).toBe("Original instruction");
      expect(detail.body.fileContents).toStrictEqual([
        { path: "references/context.md", content: "Original attachment" },
      ]);
      const automations = await accept(
        automationClient().list({
          headers: headers(),
          params: { workflowId: copied.body.id },
        }),
        [200],
      );
      expect(automations.body).toHaveLength(1);
      const automation = automations.body[0];
      if (!automation) {
        throw new Error("Expected copied webhook automation");
      }
      expect(automation.chatThreadId).toBeTruthy();
      const secret = await accept(
        automationClient().revealWebhookSecret({
          headers: headers(),
          params: { id: automation.id },
          body: undefined,
        }),
        [200],
      );
      const original = await accept(
        automationClient().revealWebhookSecret({
          headers: headers(),
          params: { id: args.automation.id },
          body: undefined,
        }),
        [200],
      );
      expect(secret.body.webhookSecret).toBe(original.body.webhookSecret);
      expect(secret.body.webhookUrl).not.toBe(original.body.webhookUrl);
    },
    30_000,
  );

  it.each([
    "source edited",
    "source deleted",
    "automation paused",
    "target deleted",
  ] as const)(
    "rejects publication after %s while upload is stalled",
    async (change) => {
      const args = await scenario();
      const gate = holdPreparation("upload");
      const copying = startCopy(args, gate);
      await gate.entered;
      switch (change) {
        case "source edited": {
          await accept(
            detailClient().update({
              headers: headers(),
              params: { workflowId: args.workflowId },
              body: { displayName: "Changed source" },
            }),
            [200],
          );
          break;
        }
        case "source deleted": {
          await accept(
            detailClient().delete({
              headers: headers(),
              params: { workflowId: args.workflowId },
            }),
            [204],
          );
          break;
        }
        case "automation paused": {
          await accept(
            automationClient().disable({
              headers: headers(),
              params: { id: args.automation.id },
            }),
            [200],
          );
          break;
        }
        case "target deleted": {
          await bdd.deleteAgent(args.actor, args.target.agentId);
          break;
        }
      }
      gate.release();
      await expect(copying).resolves.toMatchObject({ status: 409 });
      await expectNoCopy(args.target.agentId);
    },
    30_000,
  );
});
