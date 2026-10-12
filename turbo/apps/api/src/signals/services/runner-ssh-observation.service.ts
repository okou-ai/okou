import type { RunnerSshObservationRequest } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshConnectionObservations } from "@okouai/db/schema/ssh-connection-observation";
import {
  and,
  eq,
  exists,
  inArray,
  lt,
  ne,
  not,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { command } from "ccstate";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import {
  createRunnerSshMutationReads,
  type RunnerSshHostIdentity,
} from "./runner-ssh-mutation-query";
import { availableRunnerMutationAuthority } from "./runner-ssh-mutation-result";

interface ObservationAttempt {
  readonly retry: boolean;
  readonly outcome: "recorded" | "ignored" | "unavailable";
  readonly notify: boolean;
}
function observationSelection(
  source: { readonly id: SQLWrapper; readonly generation: SQLWrapper },
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
  ): Promise<ObservationAttempt> => {
    const db = set(writeDb$);
    const reads = createRunnerSshMutationReads(input, initial);
    const { observed, host, current, eligible } = reads;
    const previous = db.$with("previous_runner_ssh_observation").as(
      db
        .select({
          id: sshConnectionObservations.connectionId,
          observedAt: sshConnectionObservations.observedAt,
          failureReason: sshConnectionObservations.failureReason,
        })
        .from(sshConnectionObservations)
        .innerJoin(
          eligible,
          and(
            eq(sshConnectionObservations.connectionId, eligible.id),
            eq(sshConnectionObservations.generation, eligible.generation),
          ),
        ),
    );
    // A successful observation republishes the Host tuple without changing logical
    // metadata. A waiting observation then cannot use an obsolete prior-failure read.
    const stamped = db.$with("stamped_runner_observation_host").as(
      db
        .update(sshConnections)
        .set({ displayName: sql`${sshConnections.displayName}` })
        .where(
          inArray(
            sshConnections.id,
            db
              .select({ id: eligible.id })
              .from(eligible)
              .where(
                and(
                  eq(eligible.generation, input.expectedGeneration),
                  or(
                    not(exists(db.select({ id: previous.id }).from(previous))),
                    exists(
                      db
                        .select({ id: previous.id })
                        .from(previous)
                        .where(lt(previous.observedAt, observedAt)),
                    ),
                  ),
                ),
              ),
          ),
        )
        .returning({
          id: sshConnections.id,
          generation: sshConnections.generation,
        }),
    );
    const values = {
      generation: input.expectedGeneration,
      observedAt,
      failureReason: input.failureReason,
    };
    const written = db.$with("written_runner_ssh_observation").as(
      db
        .insert(sshConnectionObservations)
        .select(
          db
            .select(observationSelection(stamped, input, observedAt))
            .from(stamped),
        )
        .onConflictDoUpdate({
          target: sshConnectionObservations.connectionId,
          set: values,
          setWhere: or(
            ne(sshConnectionObservations.generation, input.expectedGeneration),
            lt(sshConnectionObservations.observedAt, observedAt),
          ),
        })
        .returning({ id: sshConnectionObservations.connectionId }),
    );
    const [row] = await db
      .with(...reads.ctes, previous, stamped, written)
      .select({
        retry:
          sql`coalesce(${ne(host.version, observed.version)}, false)`.mapWith(
            pgBooleanDecoder,
          ),
        current: reads.fields,
        eligibleId: eligible.id,
        writtenId: written.id,
        previousFailure: previous.failureReason,
      })
      .from(observed)
      .leftJoin(host, eq(host.id, observed.id))
      .leftJoin(current, eq(current.id, host.id))
      .leftJoin(eligible, eq(eligible.id, current.id))
      .leftJoin(previous, eq(previous.id, current.id))
      .leftJoin(written, eq(written.id, current.id));
    signal.throwIfAborted();
    if (row?.retry) {
      return { retry: true, outcome: "unavailable", notify: false };
    }
    if (!row || !availableRunnerMutationAuthority(row)) {
      return { retry: false, outcome: "unavailable", notify: false };
    }
    return {
      retry: false,
      outcome: row.writtenId === null ? "ignored" : "recorded",
      notify:
        row.writtenId !== null &&
        (input.failureReason !== null || row.previousFailure !== null),
    };
  },
);
