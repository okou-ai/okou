import type {
  RunnerSshPinRequest,
  RunnerSshPinResponse,
} from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { and, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { command } from "ccstate";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
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

interface PinAttempt {
  readonly retry: boolean;
  readonly result: RunnerSshPinResponse;
}
export const commitRunnerSshPinAttempt$ = command(
  async (
    { set },
    input: RunnerSshPinRequest & { readonly runId: string },
    initial: RunnerSshHostIdentity,
    signal: AbortSignal,
  ): Promise<PinAttempt> => {
    const db = set(writeDb$);
    const reads = createRunnerSshMutationReads(input, initial);
    const { observed, host, current, eligible } = reads;
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
        retry:
          sql`coalesce(${ne(host.version, observed.version)}, false)`.mapWith(
            pgBooleanDecoder,
          ),
        current: reads.fields,
        eligibleId: eligible.id,
        changedId: changed.id,
        changedGeneration: changed.generation,
      })
      .from(observed)
      .leftJoin(host, eq(host.id, observed.id))
      .leftJoin(current, eq(current.id, host.id))
      .leftJoin(eligible, eq(eligible.id, current.id))
      .leftJoin(changed, eq(changed.id, current.id));
    signal.throwIfAborted();
    if (row?.retry) {
      return { retry: true, result: { outcome: "unavailable" } };
    }
    const authority = availableRunnerMutationAuthority(row);
    if (!authority) {
      return { retry: false, result: { outcome: "unavailable" } };
    }
    const decision = runnerPinDecision(authority, input);
    if (decision) {
      return { retry: false, result: decision };
    }
    if (row?.changedId === null || row?.changedGeneration === null || !row) {
      throw new Error("Locked SSH connection update returned no row");
    }
    return {
      retry: false,
      result: { outcome: "pinned", generation: row.changedGeneration },
    };
  },
);
