import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  OfficialWorkflowBlueprint,
  OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import type { TestContext } from "../../../../__tests__/test-context";
import {
  acknowledgeDetachedForTest,
  createDeferredPromise,
} from "../../../utils";

export type ActiveDefinition = Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "active" }
>;

export function activeDefinition(
  name: string,
  blueprints: readonly OfficialWorkflowBlueprint[],
  instruction = "Execute only the accepted Definition content.",
): ActiveDefinition {
  return {
    name,
    lifecycle: "active",
    workflow: {
      displayName: `Display ${name}`,
      description: `Description for ${name}`,
      instruction,
      files: [{ path: "references/context.md", content: "accepted\n" }],
    },
    blueprints: [...blueprints],
    presentation: {
      category: "productivity",
      order: 1,
      marketingCopy: "Official catalog entry.",
    },
  };
}

function s3BodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error("Expected an S3 object body");
}

function missingS3Object(key: string): Error {
  return Object.assign(new Error(`Missing S3 object ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function requiredS3ObjectKey(key: string | undefined): string {
  if (!key) {
    throw new Error("Expected an S3 object key");
  }
  return key;
}

export function installCatalogStorageFixture(context: TestContext) {
  const objects = new Map<string, Buffer>();
  let nextWriteError: Error | null = null;
  let heldWrite:
    | {
        readonly started: ReturnType<typeof createDeferredPromise<void>>;
        readonly release: ReturnType<typeof createDeferredPromise<void>>;
      }
    | undefined;
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = null;
        throw error;
      }
      const key = requiredS3ObjectKey(command.input.Key);
      if (heldWrite) {
        const gate = heldWrite;
        heldWrite = undefined;
        gate.started.resolve(undefined);
        return gate.release.promise.then(() => {
          objects.set(key, s3BodyBuffer(command.input.Body));
          return {};
        });
      }
      objects.set(key, s3BodyBuffer(command.input.Body));
      return Promise.resolve({});
    }
    if (command instanceof HeadObjectCommand) {
      const key = requiredS3ObjectKey(command.input.Key);
      const body = objects.get(key);
      return body
        ? Promise.resolve({ ContentLength: body.length })
        : Promise.reject(missingS3Object(key));
    }
    if (command instanceof GetObjectCommand) {
      const key = requiredS3ObjectKey(command.input.Key);
      const body = objects.get(key);
      return body
        ? Promise.resolve({
            Body: {
              async *[Symbol.asyncIterator]() {
                yield body;
              },
            },
            ContentLength: body.length,
          })
        : Promise.reject(missingS3Object(key));
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return Promise.resolve({
        Contents: [...objects.entries()].flatMap(([Key, body]) => {
          return Key.startsWith(prefix)
            ? [{ Key, Size: body.length, LastModified: new Date(0) }]
            : [];
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
    if (!fallback) {
      return Promise.reject(
        new Error(
          `Unexpected S3 command in Official Workflow storage fixture: ${command?.constructor.name ?? "unknown"}`,
        ),
      );
    }
    return fallback(command);
  });
  return {
    readObject(key: string): Buffer {
      const object = objects.get(key);
      if (!object) {
        throw new Error(`Missing test snapshot object ${key}`);
      }
      return object;
    },
    objectCount(): number {
      return objects.size;
    },
    failNextWrite(error: Error): void {
      nextWriteError = error;
    },
    holdNextWrite() {
      if (heldWrite) {
        throw new Error("An S3 write is already held");
      }
      const started = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      heldWrite = { started, release };
      return {
        started: started.promise,
        resolve(): void {
          release.resolve(undefined);
        },
        reject(error: Error): void {
          acknowledgeDetachedForTest(release.promise);
          release.reject(error);
        },
      };
    },
  };
}
