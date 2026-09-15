/* eslint-disable no-restricted-imports -- #34243 has no API producer. This subprocess fixture publishes real durable H1 to prove recovery after process exit. */
/** An actual short-lived process publishes H1; no loader or memory survives it. */
import { createHash } from "node:crypto";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { db, closeDbPool } from "../../lib/db";
import { publishPiInferenceObject } from "../../signals/services/pi-inference-object.service";
import { piDeferredH1Schema } from "../../signals/services/pi-deferred-sandbox-contract";

const [
  orgId,
  userId,
  sessionId,
  large,
  provider = "deepseek",
  model = "deepseek-v4-flash",
] = process.argv.slice(2);
if (!orgId || !userId || !sessionId) {
  throw new Error("Missing synthetic publisher identity");
}
async function publishFixture(
  orgId: string,
  userId: string,
  sessionId: string,
) {
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: sessionId,
  });
  session.appendMessage({
    role: "user",
    content:
      large === "large"
        ? "x".repeat(6 * 1024 * 1024)
        : "Synthetic foundation fixture",
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tool-1",
        name: "read",
        arguments: { path: "/home/user/workspace/README.md" },
      },
    ],
    api:
      provider === "openai-codex"
        ? "openai-codex-responses"
        : "openai-completions",
    provider,
    model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  const sessionHistory = session.toJsonl();
  const hash = await publishPiInferenceObject(
    db(),
    { orgId, userId },
    "h1",
    piDeferredH1Schema,
    {
      schemaVersion: 1,
      manifestGeneration: 3,
      lastEventSequence: 4,
      sessionHistory,
      historyHash: createHash("sha256").update(sessionHistory).digest("hex"),
    },
  );
  process.stdout.write(JSON.stringify({ hash }));
}
try {
  await publishFixture(orgId, userId, sessionId);
} finally {
  await closeDbPool();
}
