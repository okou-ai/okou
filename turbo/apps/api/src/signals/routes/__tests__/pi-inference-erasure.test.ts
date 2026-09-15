import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { runsByIdContract } from "@okouai/api-contracts/contracts/run-routes";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  seedPiInferenceFixture,
  removePiInferenceFixture,
  seedPiInferenceUsage,
  settlePiInferenceFixture,
  readPiInferenceFixture,
  type PiInferenceFixture,
} from "../../../test-fixtures/pi-inference-lifecycle";
import {
  countPiErasureInferenceFixture,
  erasePiInferenceRunSetFixture,
  readPiErasureEvidenceFixture,
  removePiErasureEvidenceFixture,
  seedPiErasureHistoryFixture,
  settlePiErasureUsageFixture,
} from "../../../test-fixtures/pi-inference-erasure";
import { runsRoutes } from "../runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

async function fixture(
  args: Parameters<typeof seedPiInferenceFixture>[0] = {},
) {
  const f = await seedPiInferenceFixture(args);
  onTestFinished(async () => {
    await removePiInferenceFixture(f);
    await removePiErasureEvidenceFixture(f);
  });
  await seedPiErasureHistoryFixture(f);
  await seedPiInferenceUsage(f);
  return f;
}

function read(f: PiInferenceFixture) {
  createRouteMocks(context).clerk.session(f.userId, f.orgId);
  return setupApp({ context, routes: runsRoutes })(runsByIdContract).getById({
    headers: { authorization: "Bearer clerk-session" },
    params: { id: f.runId },
  });
}

function largeTargetSet(first: PiInferenceFixture, last: PiInferenceFixture) {
  const ids = [
    first.runId,
    ...Array.from({ length: 65_534 }, () => {
      return randomUUID();
    }),
    last.runId,
  ];
  expect(new Set(ids).size).toBe(65_536);
  return ids;
}

async function expectRetained(f: PiInferenceFixture) {
  await accept(read(f), [200]);
  await expect(readPiErasureEvidenceFixture(f)).resolves.toStrictEqual({
    history: [{ count: 1 }],
    blob: [{ references: 1 }],
    usage: [{ runId: f.runId, quantity: 1 }],
  });
}

async function expectErased(f: PiInferenceFixture) {
  await accept(read(f), [404]);
  await expect(readPiErasureEvidenceFixture(f)).resolves.toStrictEqual({
    history: [{ count: 0 }],
    blob: [{ references: 0 }],
    usage: [{ runId: null, quantity: 1 }],
  });
}

// Infrastructure exception: no production API accepts a padded captured Run
// set or creates the default-off Pi lifecycle. These cases exercise PostgreSQL
// Bind limits, complete-set preflight and rollback through the actual shared
// deletion path. Public Run existence still uses the production read endpoint;
// bindings, usage retention and blob accounting have no public response fields.
describe("Pi inference erasure parameter boundary", () => {
  it("deletes a large legacy target set with empty Pi lifecycle state", async () => {
    const first = await fixture({ legacy: true });
    const last = await fixture({ legacy: true });
    const ids = largeTargetSet(first, last);
    await expect(countPiErasureInferenceFixture(ids)).resolves.toStrictEqual([
      { count: 0 },
    ]);

    const erased = await erasePiInferenceRunSetFixture(ids);
    expect(erased.result).toStrictEqual({
      ok: true,
      value: {
        deletedConversations: 2,
        releasedReferences: 2,
        releasedHashes: 2,
      },
    });
    expect(erased.preflightParameters).toHaveLength(1);
    expect(erased.preflightParameters[0]).toHaveLength(5);
    expect(erased.preflightParameters[0]?.[0]).toStrictEqual(ids);
    await expectErased(first);
    await expectErased(last);
  });

  it.each(["usage", "lease"] as const)(
    "a protected %s target at the end prevents every deletion until settled and released",
    async (blocker) => {
      const first = await fixture({ legacy: true });
      const last = await fixture(
        blocker === "usage"
          ? { phase: "provider" }
          : { phase: "terminal", leaseState: "releasing" },
      );
      if (blocker === "lease") {
        await settlePiErasureUsageFixture(last);
      }
      const ids = largeTargetSet(first, last);
      const before = await readPiInferenceFixture(last);
      const blocked = await erasePiInferenceRunSetFixture(ids);
      expect(blocked.result).toMatchObject({
        ok: false,
        error: {
          message:
            "Pi inference erasure awaits usage or Sandbox release evidence",
          cause: { code: "55P03" },
        },
      });
      expect(blocked.deletionStatements).toBe(0);
      await expectRetained(first);
      await expectRetained(last);
      await expect(readPiInferenceFixture(last)).resolves.toStrictEqual(before);

      await settlePiInferenceFixture(last);
      const erased = await erasePiInferenceRunSetFixture(ids);
      expect(erased.result).toMatchObject({
        ok: true,
        value: { deletedConversations: 2, releasedReferences: 2 },
      });
      await expectErased(first);
      await expectErased(last);
    },
  );

  it("rolls back large-set deletion and blob releases on a later failure", async () => {
    const first = await fixture({ legacy: true });
    const last = await fixture({ phase: "terminal", leaseState: "released" });
    await settlePiInferenceFixture(last);
    const before = await readPiInferenceFixture(last);
    const erased = await erasePiInferenceRunSetFixture(
      largeTargetSet(first, last),
      { rollbackAfterRelease: true },
    );
    expect(erased.result).toMatchObject({
      ok: false,
      error: { message: "Synthetic failure after erasure release" },
    });
    await expectRetained(first);
    await expectRetained(last);
    await expect(readPiInferenceFixture(last)).resolves.toStrictEqual(before);
  });

  it("leaves empty input as a no-op", async () => {
    const erased = await erasePiInferenceRunSetFixture([]);
    expect(erased).toStrictEqual({
      result: {
        ok: true,
        value: {
          deletedConversations: 0,
          releasedReferences: 0,
          releasedHashes: 0,
        },
      },
      preflightParameters: [],
      deletionStatements: 0,
    });
  });

  it("erases an ordinary small not-started scope", async () => {
    const f = await fixture();
    const erased = await erasePiInferenceRunSetFixture([f.runId]);
    expect(erased.result).toMatchObject({
      ok: true,
      value: { deletedConversations: 1, releasedReferences: 1 },
    });
    await expectErased(f);
  });
});
