import type {
  RunnerSshPinRequest,
  RunnerSshPinResponse,
} from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  createRunnerSshMutationReads,
  type RunnerSshHostIdentity,
} from "./runner-ssh-mutation-query";
import {
  availableRunnerMutationAuthority,
  runnerPinDecision,
} from "./runner-ssh-mutation-result";

export const commitRunnerSshPinAttempt$ = command(
  async (
    { set },
    input: RunnerSshPinRequest & { readonly runId: string },
    initial: RunnerSshHostIdentity,
    signal: AbortSignal,
  ): Promise<RunnerSshPinResponse> => {
    const db = set(writeDb$);
    const reads = createRunnerSshMutationReads(input, initial);
    const { host, current, eligible } = reads;
    const changed = db.$with("pinned_runner_ssh_host").as(
      db
        .update(sshConnections)
        .set({
          learnedHostKeyAlgorithm: input.observedHostKey.algorithm,
          learnedHostKeyFingerprint: input.observedHostKey.fingerprint,
          generation: sql`${sshConnections.generation} + 1`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            inArray(
              sshConnections.id,
              db.select({ id: eligible.id }).from(eligible),
            ),
            eq(sshConnections.generation, input.expectedGeneration),
            eq(sshConnections.createdAt, sql`${initial.createdAt}::timestamp`),
            lt(sshConnections.generation, 2_147_483_647),
            isNull(sshConnections.learnedHostKeyAlgorithm),
            isNull(sshConnections.learnedHostKeyFingerprint),
          ),
        )
        .returning({
          id: sshConnections.id,
          generation: sshConnections.generation,
        }),
    );
    const [row] = await db
      .with(...reads.ctes, changed)
      .select({
        current: reads.fields,
        eligibleId: eligible.id,
        changedId: changed.id,
        changedGeneration: changed.generation,
      })
      .from(host)
      .leftJoin(current, eq(current.id, host.id))
      .leftJoin(eligible, eq(eligible.id, current.id))
      .leftJoin(changed, eq(changed.id, current.id));
    signal.throwIfAborted();
    if (row?.changedId && row.changedGeneration !== null) {
      return { outcome: "pinned", generation: row.changedGeneration };
    }
    const authority = availableRunnerMutationAuthority(row);
    if (!authority) {
      return { outcome: "unavailable" };
    }
    const decision = runnerPinDecision(authority, input);
    if (decision) {
      return decision;
    }
    // Classify a concurrent winner through a fresh read; do not replay the pin.
    const [latest] = await db
      .with(...reads.ctes)
      .select({ current: reads.fields, eligibleId: eligible.id })
      .from(host)
      .leftJoin(current, eq(current.id, host.id))
      .leftJoin(eligible, eq(eligible.id, current.id));
    signal.throwIfAborted();
    const latestAuthority = availableRunnerMutationAuthority(latest);
    if (!latestAuthority) {
      return { outcome: "unavailable" };
    }
    return (
      runnerPinDecision(latestAuthority, input) ?? {
        outcome: "configuration_changed",
      }
    );
  },
);
