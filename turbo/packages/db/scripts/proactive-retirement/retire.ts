import { readFile } from "node:fs/promises";
import type postgres from "postgres";

const definitions = [
  "morning-brief",
  "internal-test-morning-brief",
  "agent-suggestions",
  "proactive-learning",
  "proactive-action",
  "proactive-planning",
  "proactive-jobs",
];

async function remainingInstallations(db: postgres.Sql) {
  const [source] = await db<{ workflows: number; enrollments: number }[]>`
    SELECT (SELECT count(*)::int FROM workflows WHERE visibility='private'
      AND official_definition_name IN ${db(definitions)}) AS workflows,
      (SELECT count(*)::int FROM morning_brief_enrollments) AS enrollments`;
  if (!source) {
    throw new Error("Missing proactive retirement source counts");
  }
  return source;
}

interface RetirementReceipt {
  invalid: string | null;
  busy: string | null;
  rollbackRelease: string;
  workflows: number;
  automations: number;
  enrollments: number;
  runs: number;
}

/** Replay the completed two-release handoff on migration test fixtures. */
export async function retireProactiveInstallations(
  db: postgres.Sql,
  verifiedRelease: string,
  mode: "prepare" | "retire" = "retire",
) {
  if (!/^[a-f0-9]{40}$/u.test(verifiedRelease)) {
    throw new Error("Expected the full verified API release SHA");
  }
  const source = await remainingInstallations(db);
  if (source.workflows === 0 && source.enrollments === 0) {
    return { status: "nothing-to-retire" as const };
  }

  try {
    const [gate] = await db<
      {
        phase: string;
        first: string | null;
        recorded: boolean;
        drained: boolean | null;
      }[]
    >`
      WITH state AS MATERIALIZED (
        SELECT phase,archive_reader_release AS first,
          archive_reader_verified_at <= now() - interval '5 minutes' AS drained
        FROM proactive_dispatch_handoff WHERE singleton FOR UPDATE NOWAIT
      ), mark AS (
        UPDATE proactive_dispatch_handoff h SET archive_reader_release=${verifiedRelease},archive_reader_verified_at=now()
        FROM state WHERE h.singleton AND state.phase='standalone' AND state.first IS NULL RETURNING 1
      ) SELECT state.*, EXISTS(SELECT FROM mark) AS recorded FROM state`;
    if (!gate) {
      throw new Error("Missing proactive dispatch handoff");
    }
    if (gate.phase !== "standalone") {
      return { status: "awaiting-standalone-dispatch" as const };
    }
    if (gate.recorded) {
      return {
        status: "first-compatible-release" as const,
        release: verifiedRelease,
      };
    }
    if (gate.first === verifiedRelease || !gate.drained) {
      return {
        status: "awaiting-distinct-drained-release" as const,
        release: gate.first,
      };
    }

    if (mode === "prepare") {
      return { status: "ready-to-drain" as const };
    }

    const retirement = await readFile(
      new URL("./retire.sql", import.meta.url),
      "utf8",
    );
    const [receipt] = await db.unsafe<RetirementReceipt[]>(retirement, [
      verifiedRelease,
      JSON.stringify(definitions),
    ]);
    if (!receipt) {
      throw new Error("Proactive retirement release gate changed");
    }
    const { invalid, busy, ...counts } = receipt;
    if (invalid) {
      throw new Error(invalid);
    }
    if (busy) {
      return { status: "awaiting-legacy-work" as const, reason: busy };
    }
    if (counts.workflows === 0 && counts.enrollments === 0) {
      return { status: "nothing-to-retire" as const };
    }
    return { status: "retired" as const, ...counts };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "55P03") {
      return { status: "awaiting-database-lock" as const };
    }
    throw error;
  }
}
