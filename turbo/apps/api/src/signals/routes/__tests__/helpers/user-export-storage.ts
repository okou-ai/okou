import { randomUUID } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";

import type { TestContext } from "../../../../__tests__/test-context";

/** Keep other fixture objects readable while accepting the export upload. */
export function installUserExportStorage(context: TestContext): void {
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof CreateMultipartUploadCommand &&
      command.input.Key?.startsWith("exports/")
    ) {
      return Promise.resolve({ UploadId: randomUUID() });
    }
    if (
      command instanceof UploadPartCommand &&
      command.input.Key?.startsWith("exports/")
    ) {
      return Promise.resolve({ ETag: `"${randomUUID()}"` });
    }
    if (
      (command instanceof CompleteMultipartUploadCommand ||
        command instanceof AbortMultipartUploadCommand) &&
      command.input.Key?.startsWith("exports/")
    ) {
      return Promise.resolve({});
    }
    return fallback?.(command) ?? Promise.resolve({});
  });
}

/** The uploaded bytes are the downloadable file, independent of ZIP internals. */
export function readUserExportZip(
  context: TestContext,
  exportKey: string,
): AdmZip {
  const complete = context.mocks.s3.send.mock.calls.find(([command]) => {
    return (
      command instanceof CompleteMultipartUploadCommand &&
      command.input.Key === exportKey
    );
  })?.[0];
  if (!(complete instanceof CompleteMultipartUploadCommand)) {
    throw new Error(`Expected completed export upload for ${exportKey}`);
  }
  const parts = context.mocks.s3.send.mock.calls
    .map(([command]) => {
      return command;
    })
    .filter((command): command is UploadPartCommand => {
      return (
        command instanceof UploadPartCommand &&
        command.input.Key === exportKey &&
        command.input.UploadId === complete.input.UploadId
      );
    })
    .sort((left, right) => {
      return (left.input.PartNumber ?? 0) - (right.input.PartNumber ?? 0);
    })
    .map((command) => {
      if (!(command.input.Body instanceof Uint8Array)) {
        throw new Error("Expected export upload bytes");
      }
      return Buffer.from(command.input.Body);
    });
  if (parts.length === 0) {
    throw new Error(`Expected export upload parts for ${exportKey}`);
  }
  return new AdmZip(Buffer.concat(parts));
}

export function readExportText(zip: AdmZip, path: string): string {
  const entry = zip.getEntry(path);
  if (entry === null) {
    throw new Error(`Expected export entry ${path}`);
  }
  return entry.getData().toString("utf8");
}

export function readExportJsonLines(zip: AdmZip, path: string) {
  const text = readExportText(zip, path).trimEnd();
  return text.length === 0
    ? []
    : text.split("\n").map((line) => {
        return JSON.parse(line) as Record<string, unknown>;
      });
}

export function readExportChatRows(zip: AdmZip, threadId: string) {
  return readExportJsonLines(zip, `chat-messages/${threadId}.jsonl`).map(
    (row) => {
      return chatEventRowSchema.parse(row);
    },
  );
}
