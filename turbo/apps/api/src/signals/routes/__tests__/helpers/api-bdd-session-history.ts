import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { TestContext } from "../../../../__tests__/test-context";

function knownSessionHistoryBodies(runId: string): readonly string[] {
  return [
    `bdd agentphone history ${runId}`,
    `calendar webhook history ${runId}`,
    `bdd chat session history ${runId}`,
    `bdd chat thread history ${runId}`,
    `bdd cancelled history ${runId}`,
    `bdd cleanup-first session history ${runId}`,
    `bdd empty history ${runId}`,
    `bdd github session history ${runId}`,
    `bdd null vars history ${runId}`,
    `bdd run reads history ${runId}`,
    `bdd schedule history ${runId}`,
    `bdd session history ${runId}`,
    `bdd session history ${runId}`,
    `bdd slack history ${runId}`,
    `bdd teams history ${runId}`,
    `bdd timing session history ${runId}`,
    `bdd snapshot history ${runId}`,
    `bdd zero detail ${runId}`,
    `morning brief history ${runId}`,
    `pi jsonl history ${runId}`,
    `slack dispatch probe ${runId}`,
    `workflow automation history ${runId}`,
    `workflow queue api history ${runId}`,
  ];
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function registerKnownSessionHistoryBlob(
  context: TestContext,
  runId: string,
  hash: string,
): Uint8Array | undefined {
  for (const body of knownSessionHistoryBodies(runId)) {
    if (hashText(body) === hash) {
      const blob = Buffer.from(body, "utf8");
      context.sessionHistoryBlobs.set(hash, blob);
      return blob;
    }
  }
  return undefined;
}

export function sessionHistoryBlobBodyForKey(
  context: TestContext,
  key: string,
): Uint8Array | undefined {
  const match = /^blobs\/([a-f0-9]{64})\.blob$/.exec(key);
  if (!match) {
    return undefined;
  }
  const hash = match[1];
  if (!hash) {
    return undefined;
  }
  return context.sessionHistoryBlobs.get(hash);
}
