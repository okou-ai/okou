import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { TestContext } from "../../../../__tests__/test-context";

/** Preserve immutable reference objects alongside a test's byte-storage fixture. */
export function installArtifactReferenceStorage(context: TestContext): void {
  const objects = new Map<string, Buffer>();
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation(async (command) => {
    if (
      (command instanceof PutObjectCommand ||
        command instanceof GetObjectCommand) &&
      command.input.Key?.startsWith("artifact-references/")
    ) {
      const key = `${command.input.Bucket}/${command.input.Key}`;
      if (command instanceof PutObjectCommand) {
        if (command.input.IfNoneMatch === "*" && objects.has(key)) {
          throw Object.assign(new Error("Object already exists"), {
            name: "PreconditionFailed",
          });
        }
        const body = command.input.Body;
        if (typeof body !== "string" && !(body instanceof Uint8Array)) {
          throw new Error("Expected reference object bytes");
        }
        const result = await storage(command);
        objects.set(key, Buffer.from(body));
        return result;
      }
      const body = objects.get(key);
      if (!body) {
        throw Object.assign(new Error("Object is missing"), {
          name: "NoSuchKey",
        });
      }
      return {
        Body: Readable.from([body]),
        ETag: `"${createHash("sha256").update(body).digest("hex")}"`,
      };
    }
    return await storage(command);
  });
}
