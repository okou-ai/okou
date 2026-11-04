import type { RunnerSshObservationRequest } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionObservations } from "@okouai/db/schema/ssh-connection-observation";
import { and, eq, lt, ne, or, sql, type SQLWrapper } from "drizzle-orm";
import { command } from "ccstate";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  createRunnerSshMutationReads,
  type RunnerSshHostIdentity,
} from "./runner-ssh-mutation-query";
import { availableRunnerMutationAuthority } from "./runner-ssh-mutation-result";

interface ObservationResult {
  readonly outcome: "recorded" | "ignored" | "unavailable";
  readonly notify: boolean;
}
function observationSelection(
  source: {
    readonly id: SQLWrapper;
    readonly generation: SQLWrapper;
    readonly createdAt: SQLWrapper;
  },
  input: RunnerSshObservationRequest,
  observedAt: Date,
) {
  return {
    connectionId: sql`${source.id}`
      .mapWith(sshConnectionObservations.connectionId)
      .as("connection_id"),
    generation: sql`${source.generation}`
      .mapWith(sshConnectionObservations.generation)
      .as("generation"),
    connectionCreatedAt: sql`${source.createdAt}`
      .mapWith(sshConnectionObservations.connectionCreatedAt)
      .as("connection_created_at"),
    observedAt: sql`${observedAt.toISOString()}::timestamptz`
      .mapWith(sshConnectionObservations.observedAt)
      .as("observed_at"),
    failureReason: sql`${input.failureReason}::text`
      .mapWith(
        nullableDriverValueDecoder(sshConnectionObservations.failureReason),
      )
      .as("failure_reason"),
  };
}
export const commitRunnerSshObservationAttempt$ = command(
  async (
    { set },
    input: RunnerSshObservationRequest & { readonly runId: string },
    initial: RunnerSshHostIdentity,
    observedAt: Date,
    signal: AbortSignal,
  ): Promise<ObservationResult> => {
    const db = set(writeDb$);
    const reads = createRunnerSshMutationReads(input, initial);
    const { host, current, eligible } = reads;
    const written = db.$with("written_runner_ssh_observation").as(
      db
        .insert(sshConnectionObservations)
        .select(
          db
            .select(observationSelection(eligible, input, observedAt))
            .from(eligible)
            .where(
              and(
                eq(eligible.generation, input.expectedGeneration),
                eq(
                  eligible.createdAt,
                  sql`${input.expectedCreatedAt}::timestamp`,
                ),
              ),
            ),
        )
        .onConflictDoUpdate({
          target: sshConnectionObservations.connectionId,
          set: {
            connectionCreatedAt: input.expectedCreatedAt,
            generation: input.expectedGeneration,
            observedAt,
            failureReason: input.failureReason,
          },
          // The incarnation FK rejects reports for a deleted/recreated Host.
          // For the same Host, generation takes precedence over report time.
          setWhere: or(
            ne(
              sshConnectionObservations.connectionCreatedAt,
              input.expectedCreatedAt,
            ),
            and(
              eq(
                sshConnectionObservations.connectionCreatedAt,
                input.expectedCreatedAt,
              ),
              or(
                lt(
                  sshConnectionObservations.generation,
                  input.expectedGeneration,
                ),
                and(
                  eq(
                    sshConnectionObservations.generation,
                    input.expectedGeneration,
                  ),
                  lt(sshConnectionObservations.observedAt, observedAt),
                ),
              ),
            ),
          ),
        })
        .returning({ id: sshConnectionObservations.connectionId }),
    );
    const result = await settle(
      db
        .with(...reads.ctes, written)
        .select({
          current: reads.fields,
          eligibleId: eligible.id,
          writtenId: written.id,
        })
        .from(host)
        .leftJoin(current, eq(current.id, host.id))
        .leftJoin(eligible, eq(eligible.id, current.id))
        .leftJoin(written, eq(written.id, current.id)),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      const error = result.error;
      if (
        isForeignKeyViolation(error) &&
        error instanceof Error &&
        typeof error.cause === "object" &&
        error.cause !== null &&
        "constraint" in error.cause &&
        error.cause.constraint === "ssh_observation_incarnation_fk"
      ) {
        return { outcome: "unavailable", notify: false };
      }
      throw error;
    }
    const [row] = result.value;
    if (!row || !availableRunnerMutationAuthority(row)) {
      return { outcome: "unavailable", notify: false };
    }
    return {
      outcome: row.writtenId === null ? "ignored" : "recorded",
      notify: row.writtenId !== null,
    };
  },
);
