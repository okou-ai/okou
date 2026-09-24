import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import { chatAgentRunContext } from "../schema/chat-agent-run-context";
import { chatEvents } from "../schema/chat-event";
import { chatEventSnapshots } from "../schema/chat-event-snapshot";

describe("chatAgentRunContext schema", () => {
  it("exports durable source-run provenance without live-entity references", () => {
    const config = getTableConfig(chatAgentRunContext);
    const columns = new Map(
      config.columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    expect(schema.chatAgentRunContext).toBe(chatAgentRunContext);
    expect(columns).toEqual(
      new Map([
        ["id", true],
        ["source_chat_thread_id", true],
        ["source_agent_id", true],
        ["source_user_id", false],
        ["source_org_id", false],
        ["created_at", true],
      ]),
    );
    expect(config.foreignKeys).toHaveLength(0);
  });

  it("indexes copied ownership for cleanup while preserving unattributed historical rows", () => {
    const config = getTableConfig(chatAgentRunContext);

    expect(chatAgentRunContext.sourceUserId.hasDefault).toBe(false);
    expect(chatAgentRunContext.sourceOrgId.hasDefault).toBe(false);
    expect(
      config.indexes.map((index) => {
        return {
          name: index.config.name,
          unique: index.config.unique,
          columns: index.config.columns,
        };
      }),
    ).toEqual([
      {
        name: "chat_agent_run_context_source_user_idx",
        unique: false,
        columns: [expect.objectContaining({ name: "source_user_id" })],
      },
      {
        name: "chat_agent_run_context_source_org_idx",
        unique: false,
        columns: [expect.objectContaining({ name: "source_org_id" })],
      },
    ]);
  });
});

describe("chatEvents schema", () => {
  it("exposes only canonical physical storage", () => {
    const config = getTableConfig(chatEvents);

    expect(schema.chatEvents).toBe(chatEvents);
    expect(
      config.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual([
      "id",
      "chat_thread_id",
      "run_id",
      "revokes_event_id",
      "event_type",
      "payload",
      "failure_reason",
      "required_official_workflow_ids",
      "context_type",
      "context_id",
      "run_event_sequence_number",
      "run_event_id",
      "seq_id",
      "created_at",
    ]);
    expect(chatEvents.payload.notNull).toBeFalsy();
    expect(chatEvents.payload.hasDefault).toBeFalsy();
    expect(chatEvents.failureReason.notNull).toBeFalsy();
    expect(chatEvents.failureReason.hasDefault).toBeFalsy();
    expect(chatEvents.requiredOfficialWorkflowIds.notNull).toBeFalsy();
    expect(chatEvents.requiredOfficialWorkflowIds.hasDefault).toBeFalsy();
    expect(
      config.indexes
        .map((index) => {
          return index.config.name;
        })
        .sort(),
    ).toStrictEqual([
      "chat_events_control_interrupt_run_id_unique",
      "chat_events_input_automation_context_idx",
      "chat_events_pending_queue_idx",
      "chat_events_revokes_event_id_not_null_unique",
      "chat_events_run_event_seq_unique",
      "chat_events_run_terminal_unique",
      "chat_events_thread_seq_unique",
      "idx_chat_events_created_at_id",
      "idx_chat_events_run_id",
      "idx_chat_events_thread_created",
      "idx_chat_events_thread_run_terminal_created",
    ]);
    const checkNames = config.checks.map((check) => {
      return check.name;
    });
    expect(checkNames).toEqual(
      expect.arrayContaining([
        "chat_events_input_user_message_payload_check",
        "chat_events_input_payload_content_check",
        "chat_events_failure_reason_event_type_check",
        "chat_events_official_workflow_queue_claim_check",
        "chat_events_goal_open_payload_check",
        "chat_events_goal_close_payload_check",
        "chat_events_goal_marker_payload_check",
      ]),
    );
    const officialWorkflowQueueClaimCheck = config.checks.find((check) => {
      return check.name === "chat_events_official_workflow_queue_claim_check";
    });
    expect(officialWorkflowQueueClaimCheck).toBeDefined();
    if (!officialWorkflowQueueClaimCheck) {
      throw new Error("Missing Official Workflow queue claim check");
    }
    const officialWorkflowQueueClaimSql = new PgDialect().sqlToQuery(
      officialWorkflowQueueClaimCheck.value,
    ).sql;
    expect(officialWorkflowQueueClaimSql).toContain(
      '"chat_events"."required_official_workflow_ids" IS NULL',
    );
    expect(officialWorkflowQueueClaimSql).toContain(
      '"chat_events"."event_type" = \'input.prompt\'',
    );
    expect(officialWorkflowQueueClaimSql).toContain("cardinality");
    const failureReasonEventTypeCheck = config.checks.find((check) => {
      return check.name === "chat_events_failure_reason_event_type_check";
    });
    expect(failureReasonEventTypeCheck).toBeDefined();
    if (!failureReasonEventTypeCheck) {
      throw new Error("Missing Chat Event failure reason event-type check");
    }
    const failureReasonEventTypeSql = new PgDialect().sqlToQuery(
      failureReasonEventTypeCheck.value,
    ).sql;
    expect(failureReasonEventTypeSql).toContain(
      '"chat_events"."failure_reason" IS NULL',
    );
    expect(failureReasonEventTypeSql).toContain(
      '"chat_events"."event_type" = \'run.failed\'',
    );
    expect(checkNames).not.toEqual(
      expect.arrayContaining([
        "chat_events_input_user_message_check",
        "chat_events_input_content_check",
        "chat_events_goal_open_content_check",
        "chat_events_goal_close_content_check",
      ]),
    );
  });

  it("keeps run references after runs are deleted", () => {
    const foreignKeys = getTableConfig(chatEvents).foreignKeys.map(
      (foreignKey) => {
        const reference = foreignKey.reference();
        return {
          columns: reference.columns.map((column) => {
            return column.name;
          }),
          name: foreignKey.getName(),
          onDelete: foreignKey.onDelete,
        };
      },
    );

    expect(foreignKeys).toEqual([
      {
        columns: ["chat_thread_id"],
        name: "chat_events_chat_thread_id_chat_threads_id_fk",
        onDelete: "cascade",
      },
    ]);
  });
});

describe("chatEventSnapshots schema", () => {
  it("constrains pointers to the current canonical snapshot shape", () => {
    const config = getTableConfig(chatEventSnapshots);

    expect(chatEventSnapshots.terminalEventId.notNull).toBe(false);
    expect(chatEventSnapshots.terminalSeqId.notNull).toBe(false);
    expect(chatEventSnapshots.archiveSchemaVersion.default).toBe(7);
    expect(
      config.indexes.map((index) => {
        return { name: index.config.name, unique: index.config.unique };
      }),
    ).toEqual(
      expect.arrayContaining([
        {
          name: "chat_event_snapshots_object_key_idx",
          unique: false,
        },
        {
          name: "chat_event_snapshots_thread_version_unique",
          unique: true,
        },
      ]),
    );
    expect(
      config.checks.map((check) => {
        return check.name;
      }),
    ).toEqual(
      expect.arrayContaining([
        "chat_event_snapshots_archive_schema_version_check",
        "chat_event_snapshots_terminal_cursor_check",
      ]),
    );
  });
});
