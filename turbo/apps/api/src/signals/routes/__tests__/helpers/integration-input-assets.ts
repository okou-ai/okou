import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import { expect } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { nowDate } from "../../../../lib/time";
import { webFileUrlRoutes } from "../../web-file-url";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
import { createChatFilesBddApi } from "./api-bdd-chat-files";

/** Keep real imported bytes and ownership metadata at the S3 boundary. */
export function captureIntegrationInputUploads(context: TestContext) {
  const previous = context.mocks.s3.send.getMockImplementation();
  const uploads: PutObjectCommand["input"][] = [];
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof PutObjectCommand &&
      (command.input.Bucket === "test-user-artifacts" ||
        command.input.Bucket === "test-private-artifacts")
    ) {
      uploads.push(command.input);
      return Promise.resolve({});
    }
    if (
      command instanceof ListObjectsV2Command &&
      command.input.Bucket === "test-user-artifacts"
    ) {
      return Promise.resolve({
        Contents: uploads
          .filter((object) => {
            return object.Key?.startsWith(command.input.Prefix ?? "");
          })
          .map((object) => {
            return {
              Key: object.Key,
              Size: Buffer.byteLength(object.Body as Uint8Array),
              LastModified: nowDate(),
            };
          }),
      });
    }
    if (command instanceof HeadObjectCommand) {
      const object = uploads.find((upload) => {
        return (
          upload.Bucket === command.input.Bucket &&
          upload.Key === command.input.Key
        );
      });
      if (object) {
        return Promise.resolve({
          ContentLength: Buffer.byteLength(object.Body as Uint8Array),
          ContentType: object.ContentType,
          Metadata: object.Metadata,
          LastModified: nowDate(),
        });
      }
    }
    return previous ? previous(command) : Promise.resolve({});
  });
  return uploads;
}

export async function expectIntegrationInputPreview(
  context: TestContext,
  args: {
    readonly actor: ApiTestUser;
    readonly fileId: string;
    readonly contentType: string;
    readonly bytes: Buffer;
    readonly uploads: readonly PutObjectCommand["input"][];
    readonly okouToken: string | undefined;
    readonly privateFiles?: boolean;
  },
): Promise<void> {
  expect(args.uploads).toContainEqual(
    expect.objectContaining({
      Bucket: args.privateFiles
        ? "test-private-artifacts"
        : "test-user-artifacts",
      Body: args.bytes,
      ContentType: args.contentType,
    }),
  );
  createRouteMocks(context).clerk.session(
    args.actor.userId,
    args.actor.orgId,
    args.actor.orgRole,
  );
  const response = await accept(
    setupApp({ context, routes: webFileUrlRoutes })(webFilesContract).fileUrl({
      headers: { authorization: "Bearer clerk-session" },
      query: { file_id: args.fileId },
    }),
    [200],
  );
  expect(response.body.url).toBeTruthy();
  if (args.privateFiles) {
    expect(response.body.publicUrl).toBeNull();
  } else {
    expect(response.body.publicUrl).toBeTruthy();
  }
  if (!args.okouToken) {
    throw new Error("Expected the dispatched run's Okou token");
  }
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      { organization: { id: args.actor.orgId }, role: args.actor.orgRole },
    ],
    totalCount: 1,
  });
  await accept(
    setupApp({ context, routes: webFileUrlRoutes })(webFilesContract).fileUrl({
      headers: { authorization: `Bearer ${args.okouToken}` },
      query: { file_id: args.fileId },
    }),
    [200],
  );
  await expect(
    listIntegrationInputFileParts(context, args.actor),
  ).resolves.toContainEqual(
    expect.objectContaining({
      type: "file",
      fileId: args.fileId,
      contentType: args.contentType,
    }),
  );
}

export async function listIntegrationInputFileParts(
  context: TestContext,
  actor: ApiTestUser,
) {
  const chats = createChatFilesBddApi(context);
  const threads = await chats.requestThreadEvents(actor, {}, [200]);
  if (threads.status !== 200) {
    throw new Error("Expected chat thread events");
  }
  const threadIds = new Set(
    threads.body.events.flatMap((event) => {
      return event.kind === "created" ? [event.chatThreadId] : [];
    }),
  );
  const parts = [];
  for (const threadId of threadIds) {
    const events = await chats.listThreadEvents(actor, threadId);
    const revokedIds = revokedChatEventIds(events.events);
    for (const event of events.events) {
      if (event.eventType === "input.prompt" && !revokedIds.has(event.id)) {
        parts.push(
          ...event.userMessage.parts.filter((part) => {
            return part.type === "file";
          }),
        );
      }
    }
  }
  return parts;
}
