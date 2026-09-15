import "./env";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  authority,
  event,
  fixture,
  request,
  audience,
  secret,
} from "./fixture";
import { createClerkErasureBridge } from "../../src/signals/services/account-erasure-bridge";

const path = process.argv[2];
if (!path) {
  throw new Error("fixture_required");
}
const input = z
  .object({
    applicationUrl: z.string(),
    controlUrl: z.string(),
    authorityId: z.string(),
    subjectId: z.string(),
    eventId: z.string(),
    boundary: z.string(),
    confirmationRef: z.string().optional(),
    targetId: z.string().optional(),
    replayGeneration: z.string().optional(),
  })
  .parse(JSON.parse(await readFile(path, "utf8")));
const policy = authority(input.boundary === "resume" ? 2 : 1);
const f = fixture(
  input.applicationUrl,
  input.controlUrl,
  input.authorityId,
  policy,
);
let lookups = 0;
const journal = {
  ...f.journal,
  readDecisionByConfirmationRef: async (ref: string) => {
    const result = await f.journal.readDecisionByConfirmationRef(ref);
    if (input.boundary === "capture" && ++lookups === 2) {
      process.exit(71);
    }
    return result;
  },
  append: async (...args: Parameters<typeof f.journal.append>) => {
    const decision = await f.journal.append(...args);
    if (input.boundary === "unknown_commit") {
      process.exit(71);
    }
    return decision;
  },
};
const bridge = createClerkErasureBridge({
  db: f.db,
  journal,
  authorityId: input.authorityId,
  audience,
  signingSecret: secret,
  authority: policy,
});
if (!process.send) {
  throw new Error("test_ipc_required");
}
process.send({ state: "ready" });
try {
  const signal = new AbortController().signal;
  const result =
    input.targetId && input.replayGeneration
      ? await bridge.replayPage(
          {
            targetId: input.targetId,
            replayGeneration: input.replayGeneration,
          },
          signal,
        )
      : input.confirmationRef
        ? await bridge.resume(input.confirmationRef, signal)
        : await bridge.handle(
            request(
              event({ data: { id: input.subjectId, deleted: true } }),
              input.eventId,
            ),
            signal,
          );
  process.stdout.write(
    JSON.stringify(result, (_, value: unknown) => {
      return typeof value === "bigint" ? value.toString() : value;
    }),
  );
} finally {
  await f.close();
}
