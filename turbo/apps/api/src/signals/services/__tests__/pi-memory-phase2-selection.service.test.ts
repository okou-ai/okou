import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  PI_MEMORY_PHASE2_MAX_ATTEMPTS,
  PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES,
  PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES,
} from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";

import { db } from "../../../lib/db";
import {
  claimPiMemoryPhase2Job,
  failPiMemoryPhase2Job,
  PI_MEMORY_PHASE2_LEASE_DURATION_MS,
  PI_MEMORY_PHASE2_MAX_UNUSED_AGE_MS,
  PI_MEMORY_PHASE2_RETRY_DELAY_MS,
  PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS,
} from "../pi-memory-phase2-job.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2Candidates,
  type Phase2CandidateInput,
} from "./pi-memory-phase2-job.test-fixture";

const NOW = Object.freeze(new Date("2026-09-03T04:00:00.000Z"));
const DAY_MS = 24 * 60 * 60 * 1000;

describe("Pi memory Phase 2 selection", () => {
  it("pins every timing, attempt, count, byte, and digest constant", () => {
    expect(PI_MEMORY_PHASE2_LEASE_DURATION_MS).toBe(60 * 60 * 1000);
    expect(PI_MEMORY_PHASE2_RETRY_DELAY_MS).toBe(60 * 60 * 1000);
    expect(PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);
    expect(PI_MEMORY_PHASE2_MAX_UNUSED_AGE_MS).toBe(30 * DAY_MS);
    expect(PI_MEMORY_PHASE2_MAX_ATTEMPTS).toBe(3);
    expect(PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES).toBe(256);
    expect(PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES).toBe(21_036_800);

    expect(piMemoryPhase2SelectionDigest([])).toBe(
      "f95c6835f8a93234e88b26bc2162bd3cf8defd709037f6eefb14ee6ae3d56e48",
    );
    expect(
      piMemoryPhase2SelectionDigest([
        { piSessionId: "session-a", sourceHistoryHash: "a".repeat(64) },
      ]),
    ).toBe("24a9bc5c377eb5bfc66e9976218eb1c99ecb6461e2593788b2c752f4437288b2");
    expect(
      piMemoryPhase2SelectionDigest([
        { piSessionId: "a", sourceHistoryHash: "1".repeat(64) },
        { piSessionId: "b", sourceHistoryHash: "2".repeat(64) },
      ]),
    ).toBe("fa8384918a4cc1c202520f720d75e61fcebac6c0124eff016b9d4462fede1ea3");
  });

  it("uses the exact age boundary, excludes blank/no-output rows, and returns session order", async () => {
    const scope = await createPhase2TestScope("age");
    const sourceRunId = "00000000-0000-4000-8000-000000031243";
    const oldestAllowed = new Date(
      NOW.getTime() - PI_MEMORY_PHASE2_MAX_UNUSED_AGE_MS,
    );
    await insertPhase2Candidates(scope, [
      {
        piSessionId: "z-used-boundary",
        sourceCompletedAt: new Date(oldestAllowed.getTime() - DAY_MS),
        lastUsedAt: oldestAllowed,
      },
      {
        piSessionId: "used-too-old",
        sourceCompletedAt: NOW,
        lastUsedAt: new Date(oldestAllowed.getTime() - 1),
      },
      {
        piSessionId: "a-source-boundary",
        sourceRunId,
        sourceCompletedAt: oldestAllowed,
      },
      {
        piSessionId: "source-too-old",
        sourceCompletedAt: new Date(oldestAllowed.getTime() - 1),
      },
      {
        piSessionId: "used-in-future",
        sourceCompletedAt: oldestAllowed,
        lastUsedAt: new Date(NOW.getTime() + 1),
      },
      {
        piSessionId: "source-in-future",
        sourceCompletedAt: new Date(NOW.getTime() + 1),
      },
      {
        piSessionId: "blank",
        rawMemory: " \n ",
        rolloutSummary: "\t",
      },
      {
        piSessionId: "no-output",
        status: "succeeded_no_output",
      },
    ]);
    await insertPendingPhase2Job(scope);

    const claimed = await claimPiMemoryPhase2Job(db(), {
      currentTime: NOW,
      scope,
    });
    expect(
      claimed?.selected.map((candidate) => {
        return candidate.piSessionId;
      }),
    ).toStrictEqual(["a-source-boundary", "z-used-boundary"]);
    expect(claimed?.selected[0]).toMatchObject({
      piSessionId: "a-source-boundary",
      sourceRunId,
      sourceCompletedAt: oldestAllowed,
    });
  });

  it("applies every ranking tier before the 256-row boundary", async () => {
    expect.assertions(12);
    async function expectBoundaryWinner(
      label: string,
      better: Phase2CandidateInput,
      worse: Phase2CandidateInput,
    ): Promise<void> {
      const scope = await createPhase2TestScope(`ranking-${label}`);
      const fillers = Array.from({ length: 255 }, (_, index) => {
        return {
          piSessionId: `filler-${index.toString().padStart(3, "0")}`,
          usageCount: 10,
          sourceCompletedAt: NOW,
          lastUsedAt: NOW,
        } satisfies Phase2CandidateInput;
      });
      await insertPhase2Candidates(scope, [...fillers, better, worse]);
      await insertPendingPhase2Job(scope);
      const claimed = await claimPiMemoryPhase2Job(db(), {
        currentTime: NOW,
        scope,
      });
      const ids = new Set(
        claimed?.selected.map((candidate) => {
          return candidate.piSessionId;
        }),
      );
      expect(ids.size).toBe(256);
      expect(ids.has(better.piSessionId)).toBeTruthy();
      expect(ids.has(worse.piSessionId)).toBeFalsy();
    }

    await expectBoundaryWinner(
      "usage",
      { piSessionId: "better-usage", usageCount: 2 },
      { piSessionId: "worse-usage", usageCount: 1 },
    );
    await expectBoundaryWinner(
      "effective-date",
      {
        piSessionId: "better-effective-date",
        lastUsedAt: NOW,
        sourceCompletedAt: new Date(NOW.getTime() - 2),
      },
      {
        piSessionId: "worse-effective-date",
        lastUsedAt: new Date(NOW.getTime() - 1),
        sourceCompletedAt: NOW,
      },
    );
    await expectBoundaryWinner(
      "source-date",
      {
        piSessionId: "better-source-date",
        lastUsedAt: NOW,
        sourceCompletedAt: NOW,
      },
      {
        piSessionId: "worse-source-date",
        lastUsedAt: NOW,
        sourceCompletedAt: new Date(NOW.getTime() - 1),
      },
    );
    await expectBoundaryWinner(
      "session-id",
      {
        piSessionId: "z-better-session-id",
        lastUsedAt: NOW,
        sourceCompletedAt: NOW,
      },
      {
        piSessionId: "a-worse-session-id",
        lastUsedAt: NOW,
        sourceCompletedAt: NOW,
      },
    );
  });

  it("accepts the exact payload cap and stops before a one-byte overflow", async () => {
    const scope = await createPhase2TestScope("payload-cap");
    const rawMemory = "r".repeat(64 * 1024);
    const rolloutSummary = "s".repeat(16 * 1024);
    const rolloutSlug = "g".repeat(255);
    expect(
      Buffer.byteLength(rawMemory) +
        Buffer.byteLength(rolloutSummary) +
        Buffer.byteLength(rolloutSlug),
    ).toBe(82_175);
    await insertPhase2Candidates(
      scope,
      Array.from({ length: 257 }, (_, index) => {
        return {
          piSessionId: `session-${index.toString().padStart(3, "0")}`,
          rawMemory,
          rolloutSummary,
          rolloutSlug,
          sourceCompletedAt: NOW,
        };
      }),
    );
    await insertPendingPhase2Job(scope);

    const exact = await claimPiMemoryPhase2Job(db(), {
      currentTime: NOW,
      scope,
    });
    expect(exact?.selected).toHaveLength(256);
    await expect(
      failPiMemoryPhase2Job(db(), {
        ...scope,
        leaseToken: exact?.leaseToken ?? "missing",
        claimedRevision: exact?.claimedRevision ?? -1,
        claimedBaseVersionId: exact?.baseVersion.versionId ?? "missing",
        currentTime: new Date(NOW.getTime() + 1),
        errorClass: "test_retry",
      }),
    ).resolves.toBeTruthy();

    const topRanked = exact?.selected.find((candidate) => {
      return candidate.piSessionId === "session-256";
    });
    expect(topRanked).toBeDefined();
    if (!topRanked) {
      throw new Error("Expected top-ranked candidate");
    }
    await db()
      .update(piMemoryStage1Candidates)
      .set({ rawMemory: `${topRanked.rawMemory}x` })
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, "session-256"),
        ),
      );
    const oneByteOver = await claimPiMemoryPhase2Job(db(), {
      currentTime: new Date(
        NOW.getTime() + 1 + PI_MEMORY_PHASE2_RETRY_DELAY_MS,
      ),
      scope,
    });
    expect(oneByteOver?.selected).toHaveLength(255);
    expect(
      oneByteOver?.selected.some((candidate) => {
        return candidate.piSessionId === "session-001";
      }),
    ).toBeFalsy();
  });
});
