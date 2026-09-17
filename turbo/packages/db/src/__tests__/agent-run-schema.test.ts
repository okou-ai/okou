import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

function foreignKeyReference(
  table: Parameters<typeof getTableConfig>[0],
  columnName: string,
) {
  const foreignKey = getTableConfig(table).foreignKeys.find((candidate) => {
    return candidate.reference().columns.some((column) => {
      return column.name === columnName;
    });
  });
  expect(foreignKey).toBeDefined();
  if (!foreignKey) {
    throw new Error(`Missing foreign key for ${columnName}`);
  }
  return { foreignKey, reference: foreignKey.reference() };
}

describe("agentRuns circular foreign keys", () => {
  it("resolves physical circular foreign keys and the runtime projection from the root schema", async () => {
    const referenceRegistry = await import("../schema/agent-run-reference");
    expect(() => {
      return referenceRegistry.resolveAgentRunId();
    }).toThrow(
      "Agent-run schema references were resolved before schema initialization",
    );

    const { schema } = await import("../index");
    const { agentRuns } =
      await import("../schema/agent-run-session-conversation");
    const { chatThreadEvents, chatThreadEventKind } =
      await import("../schema/chat-thread-event");
    const { chatThreads } = await import("../schema/chat-thread");
    const { orgMembersMetadata } =
      await import("../schema/org-members-metadata");
    const { workflowAutomations } = await import("../schema/workflow");

    const { agentRuns: runtimeAgentRuns } =
      await import("../runtime/agent-run");
    expect(schema.agentRuns).toBe(runtimeAgentRuns);
    const runtimeSession = foreignKeyReference(runtimeAgentRuns, "session_id");
    expect(runtimeSession.foreignKey.onDelete).toBe("cascade");
    expect(runtimeSession.reference.foreignTable).toBe(schema.agentSessions);
    expect(runtimeSession.reference.foreignColumns).toEqual([
      schema.agentSessions.id,
    ]);
    const runtimeThread = foreignKeyReference(
      runtimeAgentRuns,
      "chat_thread_id",
    );
    expect(runtimeThread.foreignKey.onDelete).toBe("set null");
    expect(runtimeThread.reference.foreignTable).toBe(chatThreads);
    expect(runtimeThread.reference.foreignColumns).toEqual([chatThreads.id]);
    expect(schema.chatThreads).toBe(chatThreads);

    const chatThread = foreignKeyReference(agentRuns, "chat_thread_id");
    expect(chatThread.foreignKey.getName()).toBe(
      "agent_runs_chat_thread_id_chat_threads_id_fk",
    );
    expect(chatThread.foreignKey.onDelete).toBe("set null");
    expect(chatThread.reference.columns).toEqual([agentRuns.chatThreadId]);
    expect(chatThread.reference.foreignTable).toBe(chatThreads);
    expect(chatThread.reference.foreignColumns).toEqual([chatThreads.id]);

    const workflowAutomation = foreignKeyReference(
      agentRuns,
      "workflow_automation_id",
    );
    expect(workflowAutomation.foreignKey.getName()).toBe(
      "agent_runs_workflow_automation_id_workflow_automations_id_fk",
    );
    expect(workflowAutomation.foreignKey.onDelete).toBe("set null");
    expect(workflowAutomation.reference.columns).toEqual([
      agentRuns.workflowAutomationId,
    ]);
    expect(workflowAutomation.reference.foreignTable).toBe(workflowAutomations);
    expect(workflowAutomation.reference.foreignColumns).toEqual([
      workflowAutomations.id,
    ]);

    const agentRunConfig = getTableConfig(agentRuns);
    expect(agentRuns.triggerSource.notNull).toBe(false);
    expect(agentRuns.triggerSource.hasDefault).toBe(false);
    expect(agentRuns.autonomyBudget.notNull).toBe(false);
    expect(agentRuns.autonomyBudget.hasDefault).toBe(false);
    expect(agentRuns.launchSnapshot.notNull).toBe(false);
    expect(agentRuns.launchSnapshot.hasDefault).toBe(false);
    expect(agentRuns.langfuseTraceEnabled.name).toBe("langfuse_trace_enabled");
    expect(agentRuns.langfuseTraceEnabled.notNull).toBeTruthy();
    expect(agentRuns.langfuseTraceEnabled.hasDefault).toBeTruthy();
    expect(agentRuns.officialWorkflowProvenance.name).toBe(
      "official_workflow_provenance",
    );
    expect(agentRuns.officialWorkflowProvenance.notNull).toBe(false);
    expect(agentRuns.officialWorkflowProvenance.hasDefault).toBe(false);
    expect(agentRuns.builtInModelKeyId.notNull).toBe(false);
    expect(agentRuns.builtInModelKeyId.hasDefault).toBe(false);
    expect(agentRuns.builtInModelKeyId.name).toBe("built_in_model_key_id");
    expect(agentRuns.runnerHostname.name).toBe("runner_hostname");
    expect(agentRuns.runnerHostname.getSQLType()).toBe("varchar(255)");
    expect(agentRuns.runnerHostname.notNull).toBe(false);
    expect(agentRuns.runnerHostname.hasDefault).toBe(false);
    expect(agentRuns.runnerVersion.name).toBe("runner_version");
    expect(agentRuns.runnerVersion.getSQLType()).toBe("varchar(128)");
    expect(agentRuns.runnerVersion.notNull).toBe(false);
    expect(agentRuns.runnerVersion.hasDefault).toBe(false);
    for (const column of [
      agentRuns.selectedImageModel,
      chatThreadEvents.selectedImageModel,
      chatThreads.selectedImageModel,
      orgMembersMetadata.selectedImageModel,
    ]) {
      expect(column.name).toBe("selected_image_model");
      expect(column.notNull).toBe(false);
      expect(column.hasDefault).toBe(false);
    }
    expect(chatThreadEventKind.enumValues).toContain("image_model_updated");

    const metadataPresenceCheck = agentRunConfig.checks.find((check) => {
      return check.name === "agent_runs_metadata_presence_check";
    });
    expect(metadataPresenceCheck).toBeDefined();
    if (!metadataPresenceCheck) {
      throw new Error("Missing agent-run metadata-presence check");
    }
    const metadataPresenceSql = new PgDialect().sqlToQuery(
      metadataPresenceCheck.value,
    ).sql;
    const metadataColumns = [
      "trigger_source",
      "autonomy_budget",
      "workflow_automation_id",
      "model_provider",
      "model_provider_id",
      "model_provider_credential_scope",
      "selected_model",
      "model_runtime_provider",
      "model_runtime_model",
      "built_in_model_key_id",
      "codex_service_tier",
      "selected_video_model",
      "selected_image_model",
      "chat_thread_id",
      "api_started_at",
      "first_assistant_event_acknowledged_at",
      "summary",
      "trigger_brief",
    ] as const;
    for (const column of metadataColumns) {
      expect(metadataPresenceSql).toContain(`"agent_runs"."${column}" IS NULL`);
    }
    expect(metadataPresenceSql.match(/ IS NULL/gu)).toHaveLength(18);
    expect(metadataPresenceSql.match(/ IS NOT NULL/gu)).toHaveLength(2);
    expect(metadataPresenceSql).toContain(
      '"agent_runs"."trigger_source" IS NOT NULL',
    );
    expect(metadataPresenceSql).toContain(
      '"agent_runs"."autonomy_budget" IS NOT NULL',
    );
    expect(
      agentRunConfig.checks.map((check) => {
        return check.name;
      }),
    ).toContain("agent_runs_autonomy_budget_check");

    const launchSnapshotCheck = agentRunConfig.checks.find((check) => {
      return check.name === "agent_runs_launch_snapshot_check";
    });
    expect(launchSnapshotCheck).toBeDefined();
    if (!launchSnapshotCheck) {
      throw new Error("Missing agent-run launch-snapshot check");
    }
    const launchSnapshotSql = new PgDialect().sqlToQuery(
      launchSnapshotCheck.value,
    ).sql;
    expect(launchSnapshotSql).toContain(
      '"agent_runs"."launch_snapshot" IS NULL',
    );
    expect(launchSnapshotSql).toContain("jsonb_typeof");
    expect(launchSnapshotSql).toContain("schemaVersion");
    expect(launchSnapshotSql).toContain("framework");
    expect(launchSnapshotSql).toContain("runnerProfile");
    expect(launchSnapshotSql).toContain("piMemoryGenerationEnabled");
    expect(launchSnapshotSql).toContain("'1'");
    expect(launchSnapshotSql).toContain("'2'");
    expect(launchSnapshotSql).toContain("'3'");
    expect(launchSnapshotSql).toContain("'boolean'");
    expect(launchSnapshotSql).toContain("'claude-code'");
    expect(launchSnapshotSql).toContain("'codex'");
    expect(launchSnapshotSql).toContain("'pi'");
    expect(launchSnapshotSql).toContain(">= 1");
    expect(launchSnapshotSql).toContain("<= 255");

    const officialWorkflowProvenanceCheck = agentRunConfig.checks.find(
      (check) => {
        return check.name === "agent_runs_official_workflow_provenance_check";
      },
    );
    expect(officialWorkflowProvenanceCheck).toBeDefined();
    if (!officialWorkflowProvenanceCheck) {
      throw new Error("Missing Official Workflow provenance check");
    }
    const officialWorkflowProvenanceSql = new PgDialect().sqlToQuery(
      officialWorkflowProvenanceCheck.value,
    ).sql;
    for (const identity of [
      "schemaVersion",
      "definitions",
      "name",
      "revision",
      "artifact",
      "orgId",
      "userId",
      "storageName",
      "storageId",
      "storageVersion",
    ]) {
      expect(officialWorkflowProvenanceSql).toContain(identity);
    }
    expect(officialWorkflowProvenanceSql).toContain(
      '"agent_runs"."official_workflow_provenance" IS NULL',
    );
    expect(officialWorkflowProvenanceSql).toContain("jsonb_array_length");
    expect(officialWorkflowProvenanceSql).toContain("jsonb_path_exists");
    expect(officialWorkflowProvenanceSql).toContain("keyvalue()");
    expect(officialWorkflowProvenanceSql).toContain("__system__");
    expect(officialWorkflowProvenanceSql).toContain("__org__");
    expect(officialWorkflowProvenanceSql).toContain("^[0-9a-f]{64}$");

    const agentSessionRun = foreignKeyReference(
      chatThreads,
      "agent_session_run_id",
    );
    expect(agentSessionRun.foreignKey.getName()).toBe(
      "chat_threads_agent_session_run_id_agent_runs_id_fk",
    );
    expect(agentSessionRun.foreignKey.onDelete).toBe("set null");
    expect(agentSessionRun.reference.columns).toEqual([
      chatThreads.agentSessionRunId,
    ]);
    expect(agentSessionRun.reference.foreignTable).toBe(agentRuns);
    expect(agentSessionRun.reference.foreignColumns).toEqual([agentRuns.id]);
  });
});
