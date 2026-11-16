import { nativeContinuationSchema } from "@okouai/api-contracts/contracts/runners";
import {
  runResultSchema,
  runStatusSchema,
} from "@okouai/api-contracts/contracts/runs";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { captureBillingRunTerminalSql } from "@okouai/db/operations/billing-run-lifecycle";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { claimedWorkflowAttachments } from "@okouai/db/schema/claimed-workflow-attachment";
import { and, count, countDistinct, eq, sql, type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder, type PgColumn } from "drizzle-orm/pg-core";
import {
  enum as zEnum,
  literal,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";

type CompleteBody = zInfer<typeof webhookCompleteContract.complete.body>;
interface CompletionPublicationInput {
  readonly body: CompleteBody;
  readonly userId: string;
  readonly orgId: string;
  readonly expectedChatThreadId: string | null;
  readonly at: Date;
}

const completionRunColumns = Object.freeze({
  id: agentRuns.id,
  agentId: agentRuns.agentId,
  orgId: agentRuns.orgId,
  userId: agentRuns.userId,
  chatThreadId: agentRuns.chatThreadId,
  status: agentRuns.status,
  error: agentRuns.error,
  cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
  triggerSource: agentRuns.triggerSource,
  launchSnapshot: agentRuns.launchSnapshot,
  officialWorkflowProvenance: agentRuns.officialWorkflowProvenance,
  storageMounts: agentRuns.storageMounts,
  framework: agentRuns.framework,
  frameworkSessionId: agentRuns.frameworkSessionId,
  result: agentRuns.result,
  legacyConversationHistoryHash: agentRuns.legacyConversationHistoryHash,
  modelProvider: agentRuns.modelProvider,
  modelProviderId: agentRuns.modelProviderId,
  modelProviderCredentialScope: agentRuns.modelProviderCredentialScope,
  selectedModel: agentRuns.selectedModel,
  modelRuntimeProvider: agentRuns.modelRuntimeProvider,
  modelRuntimeModel: agentRuns.modelRuntimeModel,
});

function returned(columns: Readonly<Record<string, PgColumn>>) {
  return Object.entries(columns).map(([name, field]) => {
    return { path: [name], field };
  });
}

/** A rejected representation never supplies a successful empty result. */
function arrayElements(value: SQL) {
  return sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END)`;
}

function validResult(value: SQL) {
  return sql`jsonb_typeof(${value}) = 'object'
    AND (NOT (${value} ? 'framework') OR ${value}->>'framework' IN ('pi','claude-code','codex') AND jsonb_typeof(${value}->'framework') = 'string')
    AND (NOT (${value} ? 'frameworkSessionId') OR jsonb_typeof(${value}->'frameworkSessionId') = 'string')
    AND (NOT (${value} ? 'storageOutputs') OR jsonb_typeof(${value}->'storageOutputs') = 'array'
      AND NOT EXISTS (SELECT 1 FROM ${arrayElements(sql`${value}->'storageOutputs'`)} AS item
        WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'version') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'mountPath') IS DISTINCT FROM 'string'
          OR (item ? 'missingRootPolicy' AND (jsonb_typeof(item->'missingRootPolicy') IS DISTINCT FROM 'string' OR item->>'missingRootPolicy' NOT IN ('fail','preserveParentVersion')))))`;
}

function normalizedResult(value: SQL) {
  return sql`(CASE WHEN ${value} ? 'framework' THEN jsonb_build_object('framework',${value}->'framework') ELSE '{}'::jsonb END)
    || (CASE WHEN ${value} ? 'frameworkSessionId' THEN jsonb_build_object('frameworkSessionId',${value}->'frameworkSessionId') ELSE '{}'::jsonb END)
    || (CASE WHEN ${value} ? 'storageOutputs' THEN jsonb_build_object('storageOutputs',
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',item->'name','version',item->'version','mountPath',item->'mountPath')
        || CASE WHEN item ? 'missingRootPolicy' THEN jsonb_build_object('missingRootPolicy',item->'missingRootPolicy') ELSE '{}'::jsonb END ORDER BY ord),'[]'::jsonb)
      FROM ${arrayElements(sql`${value}->'storageOutputs'`)} WITH ORDINALITY AS entry(item,ord))) ELSE '{}'::jsonb END)`;
}

function outputFacts(input: CompletionPublicationInput) {
  const output = input.body.completion;
  const requested = sql`${JSON.stringify(output?.storageOutputs ?? [])}::jsonb`;
  return sql`SELECT r.*,
    EXISTS (SELECT 1 FROM ${arrayElements(requested)} AS requested
      WHERE NOT EXISTS (SELECT 1 FROM ${arrayElements(sql`r.storage_mounts`)} AS mount
        WHERE mount->'writeback' = 'true'::jsonb AND mount->>'name' = requested->>'name' AND mount->>'mountPath' = requested->>'mountPath'))
      OR (SELECT ${count()} FROM ${arrayElements(requested)}) <>
        (SELECT ${countDistinct(sql`jsonb_build_array(requested->'name',requested->'mountPath')`)} FROM ${arrayElements(requested)} AS requested) AS unauthorized_mount,
    EXISTS (SELECT 1 FROM ${arrayElements(sql`r.storage_mounts`)} AS mount WHERE NOT (mount ? 'version')
      AND NOT EXISTS (SELECT 1 FROM ${arrayElements(requested)} AS requested
        WHERE mount->'writeback' = 'true'::jsonb AND mount->>'name' = requested->>'name' AND mount->>'mountPath' = requested->>'mountPath')) AS missing_version,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',mount->'name','version',COALESCE(requested->'version',mount->'version'),'mountPath',mount->'mountPath')
      || CASE WHEN COALESCE(requested->'missingRootPolicy',mount->'missingRootPolicy') IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('missingRootPolicy',COALESCE(requested->'missingRootPolicy',mount->'missingRootPolicy')) END ORDER BY ord)
      FILTER (WHERE mount->'writeback' = 'true'::jsonb),'[]'::jsonb)
      FROM ${arrayElements(sql`r.storage_mounts`)} WITH ORDINALITY AS mounts(mount,ord)
      LEFT JOIN ${arrayElements(requested)} AS requested ON mount->'writeback' = 'true'::jsonb
        AND mount->>'name' = requested->>'name' AND mount->>'mountPath' = requested->>'mountPath') AS output_storage,
    ${validResult(sql`r.result`)} AS existing_valid,
    ${normalizedResult(sql`r.result`)} AS existing_result
    FROM completion_locked_run AS r`;
}

function outputIdentity(input: CompletionPublicationInput) {
  const output = input.body.completion;
  return {
    hasOutput: output !== undefined,
    type: output?.cliAgentType ?? null,
    sessionId: output?.cliAgentSessionId ?? null,
    disposition: output?.cliAgentSessionHistoryDisposition ?? null,
    nativeSessionValid: output
      ? nativeContinuationSchema.shape.sessionId.safeParse(
          output.cliAgentSessionId,
        ).success
      : false,
  };
}

function outputDecision(input: CompletionPublicationInput) {
  const identity = outputIdentity(input);
  const exactRetry = sql`r.status IN ('completed','failed','cancelled') AND r.result IS NOT NULL
    AND r.existing_valid AND r.result ? 'storageOutputs'
    AND r.framework = ${identity.type} AND r.framework_session_id = ${identity.sessionId}
    AND r.legacy_conversation_history_hash IS NULL AND r.existing_result->'storageOutputs' = r.output_storage`;
  return sql`SELECT r.*, ${exactRetry} AS exact_retry,
    (CASE WHEN ${exactRetry} THEN r.existing_result ELSE jsonb_build_object('storageOutputs',r.output_storage)
      || CASE WHEN r.launch_snapshot->>'framework' = ${identity.type}
        THEN jsonb_build_object('framework',${identity.type}::text,'frameworkSessionId',${identity.sessionId}::text)
        ELSE '{}'::jsonb END END) AS output_result,
    CASE
      WHEN r.chat_thread_id IS DISTINCT FROM ${input.expectedChatThreadId}::uuid THEN 'retry'
      WHEN r.status NOT IN ('queued','pending','running','completed','failed','timeout','cancelled') THEN 'invalid-status'
      WHEN r.status = 'timeout' OR ${!identity.hasOutput} THEN 'ready'
      WHEN r.org_id <> ${input.orgId} THEN 'not-found'
      WHEN r.unauthorized_mount THEN 'mount'
      WHEN r.storage_mounts IS NULL THEN 'missing-mounts'
      WHEN jsonb_typeof(r.storage_mounts) IS DISTINCT FROM 'array' THEN 'invalid-data'
      WHEN r.launch_snapshot->'schemaVersion' = '5'::jsonb AND
        (${identity.disposition}::text IS DISTINCT FROM 'native_only' OR NOT ${identity.nativeSessionValid}
          OR r.launch_snapshot->>'framework' IS DISTINCT FROM ${identity.type}::text
          OR r.launch_snapshot->>'framework' = 'pi' AND ${identity.sessionId}::text IS DISTINCT FROM
            CASE WHEN r.official_workflow_provenance IS NOT NULL THEN r.id::text ELSE COALESCE(r.chat_thread_id,r.id)::text END) THEN 'native'
      WHEN COALESCE(r.launch_snapshot->>'framework' = 'pi',false) <> ${identity.type === "pi"} THEN 'type'
      WHEN r.status IN ('completed','failed','cancelled') AND r.result IS NOT NULL AND NOT COALESCE(r.existing_valid,false) THEN 'invalid-data'
      WHEN r.status IN ('completed','failed','cancelled') AND r.result IS NOT NULL AND r.result ? 'storageOutputs' AND r.missing_version THEN 'invalid-version'
      WHEN ${exactRetry} THEN 'ready'
      WHEN r.status IN ('completed','failed','cancelled') AND (r.status = 'completed' OR r.result IS NOT NULL) THEN 'committed'
      WHEN r.launch_snapshot->'schemaVersion' = '5'::jsonb AND r.framework_session_id IS NOT NULL
        AND r.framework_session_id <> ${identity.sessionId}::text THEN 'native'
      WHEN r.missing_version THEN 'invalid-version'
      ELSE 'ready' END AS decision
    FROM completion_output_facts AS r`;
}

function mutationPlan(
  input: CompletionPublicationInput,
  terminalStatus: "completed" | "failed",
  terminalError: string | undefined,
) {
  const output = input.body.completion;
  const eligible = sql`d.decision = 'ready' AND d.status <> 'timeout'`;
  const active = sql`d.status IN ('pending','running')`;
  const newOutput = sql`${output !== undefined} AND NOT COALESCE(d.exact_retry,false)`;
  return new PgDialect().buildUpdateQuery({
    table: agentRuns,
    set: {
      framework: sql`CASE WHEN ${newOutput} THEN ${sql.param(output?.cliAgentType ?? null, agentRuns.framework)} ELSE ${agentRuns.framework} END`,
      frameworkSessionId: sql`CASE WHEN ${newOutput} THEN ${sql.param(output?.cliAgentSessionId ?? null, agentRuns.frameworkSessionId)} ELSE ${agentRuns.frameworkSessionId} END`,
      result: sql`CASE WHEN ${output !== undefined} THEN d.output_result ELSE ${agentRuns.result} END`,
      lastEventSequence:
        input.body.lastEventSequence === undefined
          ? sql`${agentRuns.lastEventSequence}`
          : sql`GREATEST(COALESCE(${agentRuns.lastEventSequence},-1),${input.body.lastEventSequence})`,
      status: sql`CASE WHEN ${active} THEN ${terminalStatus} ELSE ${agentRuns.status} END`,
      completedAt: sql`CASE WHEN ${active} THEN ${sql.param(input.at, agentRuns.completedAt)}::timestamp ELSE ${agentRuns.completedAt} END`,
      error: sql`CASE WHEN ${active} AND ${terminalError !== undefined} THEN ${terminalError ?? null} ELSE ${agentRuns.error} END`,
      failureReason: sql`CASE WHEN ${active} THEN ${input.body.exitCode === 0 ? null : (input.body.failureReason ?? null)} ELSE ${agentRuns.failureReason} END`,
      sandboxId:
        input.body.sandboxId === undefined
          ? sql`${agentRuns.sandboxId}`
          : sql`CASE WHEN ${active} THEN ${input.body.sandboxId} WHEN d.status = 'cancelled' THEN COALESCE(${agentRuns.sandboxId},${input.body.sandboxId}) ELSE ${agentRuns.sandboxId} END`,
      cancellationRecoveryCompleted: sql`CASE WHEN d.status = 'cancelled' AND d.cancellation_recovery_completed = false THEN true ELSE ${agentRuns.cancellationRecoveryCompleted} END`,
    },
    from: sql`completion_decision AS d`,
    joins: [],
    where: and(
      eq(agentRuns.id, sql`d.id`),
      eligible,
      sql`(${output !== undefined} OR ${input.body.lastEventSequence !== undefined} OR ${active}
        OR d.status = 'cancelled' AND (d.cancellation_recovery_completed = false OR ${input.body.sandboxId !== undefined}))`,
      sql`(SELECT ${count()} FROM completion_native_owner) >= 0`,
    ),
    returning: returned({
      id: agentRuns.id,
      agentId: agentRuns.agentId,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      chatThreadId: agentRuns.chatThreadId,
      framework: agentRuns.framework,
      frameworkSessionId: agentRuns.frameworkSessionId,
    }),
  });
}

function nativeThreadPublication() {
  return new PgDialect().buildUpdateQuery({
    table: chatThreads,
    set: {
      framework: sql`changed.framework`,
      frameworkSessionId: sql`changed.framework_session_id`,
      frameworkSessionRunId: sql`changed.id`,
    },
    from: sql`completion_changed_run AS changed`,
    joins: [],
    where: and(
      eq(chatThreads.id, sql`changed.chat_thread_id`),
      eq(chatThreads.userId, sql`changed.user_id`),
      eq(chatThreads.agentId, sql`changed.agent_id`),
      sql`EXISTS (SELECT 1 FROM completion_native_owner AS owner WHERE owner.run_id = changed.id)`,
    ),
    returning: returned({ id: chatThreads.id }),
  });
}

function terminalCleanup() {
  const dialect = new PgDialect();
  return {
    diagnostics: dialect.buildDeleteQuery({
      table: agentRunConnectorDiagnosticRegistrations,
      where: sql`${agentRunConnectorDiagnosticRegistrations.runId} IN (SELECT id FROM completion_terminal_runs)`,
      returning: returned({
        runId: agentRunConnectorDiagnosticRegistrations.runId,
      }),
    }),
    workflowAttachments: dialect.buildDeleteQuery({
      table: claimedWorkflowAttachments,
      where: sql`EXISTS (SELECT 1 FROM completion_decision AS d
        WHERE d.decision = 'ready' AND d.id = ${claimedWorkflowAttachments.runId}
          AND d.org_id = ${claimedWorkflowAttachments.orgId})
        AND (SELECT ${count()} FROM completion_changed_run) >= 0`,
      returning: returned({ runId: claimedWorkflowAttachments.runId }),
    }),
    slots: dialect.buildDeleteQuery({
      table: activeAgentRuns,
      where: sql`${activeAgentRuns.runId} IN (SELECT id FROM completion_decision WHERE decision = 'ready')
      AND (SELECT ${count()} FROM completion_changed_run) >= 0 AND (SELECT ${count()} FROM completion_native_thread) >= 0
      AND (SELECT ${count()} FROM completion_billing) >= 0 AND (SELECT ${count()} FROM completion_diagnostics) >= 0
      AND (SELECT ${count()} FROM completion_workflow_attachments) >= 0`,
      returning: returned({
        runId: activeAgentRuns.runId,
        orgId: activeAgentRuns.orgId,
      }),
    }),
  };
}

/** The existing Run/active-owner locks precede every parent write; slot DELETE stays last. */
export function completionPublicationPlan(input: CompletionPublicationInput) {
  const qb = new QueryBuilder();
  const locked = qb.$with("completion_locked_run").as(
    qb
      .select(completionRunColumns)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, input.body.runId),
          eq(agentRuns.userId, input.userId),
        ),
      )
      .for("update", { of: agentRuns })
      .limit(1),
  );
  const output = input.body.completion;
  const terminalStatus =
    input.body.exitCode === 0 && output !== undefined ? "completed" : "failed";
  const terminalError =
    input.body.exitCode !== 0
      ? input.body.error?.trim() || "Run failed without error message"
      : output === undefined
        ? "Run completion outputs were not provided"
        : undefined;
  const cleanup = terminalCleanup();
  return {
    terminalStatus,
    terminalError,
    ctes: [
      locked,
      qb.$with("completion_output_facts", {}).as(outputFacts(input)),
      qb.$with("completion_decision", {}).as(outputDecision(input)),
      // This is the same ownership-row lock previously taken by the identity
      // self-update. Reading it avoids updating and then deleting one tuple.
      qb.$with("completion_native_owner", {})
        .as(sql`SELECT owner.run_id FROM ${activeAgentRuns} AS owner JOIN completion_decision AS d ON owner.run_id = d.id
        AND owner.chat_thread_id = d.chat_thread_id AND owner.user_id = d.user_id AND owner.org_id = d.org_id
        WHERE d.decision = 'ready' AND d.status <> 'timeout' AND d.chat_thread_id IS NOT NULL AND d.agent_id IS NOT NULL
          AND ${output !== undefined} AND NOT COALESCE(d.exact_retry,false) FOR UPDATE OF owner`),
      qb
        .$with("completion_changed_run", {})
        .as(mutationPlan(input, terminalStatus, terminalError)),
      qb.$with("completion_native_thread", {}).as(nativeThreadPublication()),
      qb
        .$with("completion_terminal_runs", {})
        .as(
          sql`SELECT d.id,d.org_id,d.user_id,d.model_provider_id FROM completion_decision AS d JOIN completion_changed_run AS changed ON changed.id = d.id WHERE d.status IN ('pending','running')`,
        ),
      qb.$with("completion_billing", {}).as(
        captureBillingRunTerminalSql({
          condition: sql`${agentRuns.id} IN (SELECT id FROM completion_terminal_runs)`,
          status: terminalStatus,
          completedAt: input.at,
        }),
      ),
      qb.$with("completion_diagnostics", {}).as(cleanup.diagnostics),
      // Only an accepted Runner completion releases its exact packages. Keep
      // this in the publication statement and before releasing the active slot.
      qb
        .$with("completion_workflow_attachments", {})
        .as(cleanup.workflowAttachments),
      qb.$with("completion_released_slots", {}).as(cleanup.slots),
    ],
    from: locked,
    fields: {
      run: {
        id: locked.id,
        error: locked.error,
        orgId: locked.orgId,
        status: sql`${locked.status}`.mapWith(
          zodDriverValueDecoder(runStatusSchema),
        ),
        userId: locked.userId,
        cancellationRecoveryCompleted: locked.cancellationRecoveryCompleted,
        chatThreadId: locked.chatThreadId,
        triggerSource: locked.triggerSource,
        launchSnapshot: locked.launchSnapshot,
        modelProvider: locked.modelProvider,
        modelProviderCredentialScope: locked.modelProviderCredentialScope,
        selectedModel: locked.selectedModel,
        modelRuntimeProvider: locked.modelRuntimeProvider,
        modelRuntimeModel: locked.modelRuntimeModel,
      },
      decision: sql`(SELECT decision FROM completion_decision)`.mapWith(
        zodDriverValueDecoder(
          zEnum([
            "retry",
            "ready",
            "not-found",
            "mount",
            "native",
            "type",
            "committed",
            "missing-mounts",
            "invalid-version",
            "invalid-data",
            "invalid-status",
          ]),
        ),
      ),
      cleanupModelProviderId: locked.modelProviderId,
      outputResult:
        sql`(SELECT CASE WHEN decision = 'ready' AND status <> 'timeout' AND ${output !== undefined} THEN output_result ELSE NULL END FROM completion_decision)`.mapWith(
          zodDriverValueDecoder(runResultSchema.nullable()),
        ),
      releasedRunId:
        sql`(SELECT run_id FROM completion_released_slots)`.mapWith(
          zodDriverValueDecoder(uuid().nullable()),
        ),
      releasedOrgId:
        sql`(SELECT org_id FROM completion_released_slots)`.mapWith(
          zodDriverValueDecoder(string().nullable()),
        ),
      atomicGuard:
        sql`(CASE WHEN EXISTS (SELECT 1 FROM completion_decision WHERE decision IN ('invalid-data','invalid-status','missing-mounts','invalid-version')) OR EXISTS (SELECT 1 FROM completion_decision AS d WHERE d.decision = 'ready' AND d.status <> 'timeout' AND ${output !== undefined} AND NOT COALESCE(${validResult(sql`d.output_result`)},false)) THEN '__TX0050_INVALID_OUTPUT_STATE__' ELSE '0' END)::integer`.mapWith(
          zodDriverValueDecoder(literal(0)),
        ),
    },
  };
}
