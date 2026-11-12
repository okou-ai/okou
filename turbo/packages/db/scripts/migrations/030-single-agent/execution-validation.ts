import { literal, object, record, string, unknown } from "zod";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import {
  sha256,
  type ExecutionImage,
  type RowImage,
  type TableImage,
} from "./execution-model";
import type { plan } from "./plan";
import { PlanningError, type Snapshot } from "./snapshot";

export const mutableExecutionFields: Readonly<
  Record<string, readonly string[]>
> = {
  workflows: [
    "agent_id",
    "name",
    "owner_user_id",
    "visibility",
    "content_bundle",
    "updated_at",
  ],
  chat_threads: ["agent_id", "project_id", "updated_at"],
  agent_runs: ["workflow_automation_id"],
};

/** The pinned image may express only the reviewed migration, never general CRUD. */
export function validateExecutionImage(
  image: ExecutionImage,
  approved: ReturnType<typeof plan>,
  snapshot: Snapshot,
) {
  const fail = () => {
    throw new PlanningError("ExecutionImageDoesNotMatchApprovedActions");
  };
  if (
    image.scope.orgId !== approved.scope.orgId ||
    image.scope.target !== approved.scope.target ||
    image.scope.database !== approved.scope.database
  )
    fail();
  const deleted = new Set(
    approved.automationDeletions.map((row) => {
      return row.source.id;
    }),
  );
  const deletedBindings = new Set(
    approved.automationThreadDeletions.map((row) => {
      return row.source.id;
    }),
  );
  if (
    JSON.stringify([...image.automationIds].sort()) !==
    JSON.stringify([...deleted].sort())
  )
    fail();
  const moves = new Map(
    approved.movedWorkflows.map((row) => {
      return [row.source.id, row];
    }),
  );
  const conversions = new Map(
    approved.convertedInstructions.map((row) => {
      return [row.targetName, row];
    }),
  );
  const initializations = new Set(
    approved.personalInstructions
      .filter((row) => {
        return row.action === "initialize-once";
      })
      .map((row) => {
        return row.userId;
      }),
  );
  const groups = new Map(
    approved.projectGroups.map((row) => {
      return [JSON.stringify([row.owner, row.targetName]), row];
    }),
  );
  const chats = new Map(
    approved.projectGroups.flatMap((group) => {
      return group.chats.map((row) => {
        return [row.id, { group, row }] as const;
      });
    }),
  );
  const createdProjects = new Map<string, string>();
  const counted = new Map<string, Set<string>>();
  const sourceAgents = new Map(
    snapshot.agents.map((agent) => {
      return [agent.id, agent];
    }),
  );
  const count = (kind: string, id: string) => {
    const ids = counted.get(kind) ?? new Set<string>();
    if (ids.has(id)) fail();
    ids.add(id);
    counted.set(kind, ids);
  };
  const sourceAgent = (id: string) => {
    const row = image.tables
      .find((table) => {
        return table.name === "agents";
      })
      ?.rows.find((item) => {
        return (
          item.before !== null &&
          object({ id: string() }).parse(JSON.parse(item.before)).id === id
        );
      });
    if (!row?.before) throw new PlanningError("ExecutionSourceAgentMissing");
    const content = object({
      instructions: string(),
      instructions_bundle: contentBundleSchema,
    }).parse(JSON.parse(row.before));
    const expectedAgent = sourceAgents.get(id);
    if (!expectedAgent) throw new PlanningError("ExecutionSourceAgentMissing");
    const expected = expectedAgent.instructions;
    if (
      row.revision !== expectedAgent.revision ||
      sha256(content.instructions) !== expected.hash ||
      Buffer.byteLength(content.instructions) !== expected.bytes ||
      JSON.stringify(content.instructions_bundle) !==
        JSON.stringify(expected.bundle)
    )
      fail();
    return content;
  };
  const defaultContent = sourceAgent(approved.targetAgentId);
  const validateWorkflow = (row: RowImage) => {
    if (row.after === null) fail();
    const after = object({
      id: string(),
      agent_id: string(),
      name: string(),
      owner_user_id: string(),
      visibility: string(),
      content_bundle: contentBundleSchema,
    }).parse(JSON.parse(row.after!));
    if (
      after.agent_id !== approved.targetAgentId ||
      !image.bundles.some((bundle) => {
        return (
          bundle.sha256 === after.content_bundle.sha256 &&
          bundle.archiveBytes === after.content_bundle.archiveBytes
        );
      })
    )
      fail();
    if (row.before !== null) {
      const moved = moves.get(after.id);
      if (
        !moved ||
        moved.targetName !== after.name ||
        moved.targetOwner !== after.owner_user_id ||
        moved.targetVisibility !== after.visibility
      )
        fail();
      if (row.revision !== moved!.source.revision) fail();
      count("moves", after.id);
    } else {
      const converted = conversions.get(after.name);
      if (
        !converted ||
        converted.owner !== after.owner_user_id ||
        converted.visibility !== after.visibility
      )
        fail();
      const content = object({
        instruction: string(),
        description: literal(null),
        display_name: literal(null),
        official_definition_name: literal(null),
        official_installation_state: literal(null),
        import_source: literal(null),
        import_session_id: literal(null),
        created_by: string(),
        updated_by: string(),
        attachments: object({ kind: literal("empty") }).strict(),
      }).parse(JSON.parse(row.after!));
      if (
        content.instruction !==
          sourceAgent(converted!.sourceAgentId).instructions ||
        content.created_by !== converted!.owner ||
        content.updated_by !== converted!.owner
      )
        fail();
      count("conversions", after.name);
    }
  };
  const validatePersonal = (row: RowImage) => {
    if (row.before !== null || row.after === null) fail();
    const after = object({
      user_id: string(),
      content: string(),
      bundle: contentBundleSchema,
    }).parse(JSON.parse(row.after!));
    if (
      !initializations.has(after.user_id) ||
      after.content !== defaultContent.instructions ||
      after.bundle.sha256 !== defaultContent.instructions_bundle.sha256 ||
      after.bundle.archiveBytes !==
        defaultContent.instructions_bundle.archiveBytes
    )
      fail();
    count("initializations", after.user_id);
  };
  const validateChat = (row: RowImage) => {
    if (row.before === null || row.after === null) fail();
    const after = object({
      id: string(),
      user_id: string(),
      agent_id: string(),
      project_id: string(),
    }).parse(JSON.parse(row.after!));
    const group = chats.get(after.id);
    if (
      !group ||
      after.agent_id !== approved.targetAgentId ||
      after.user_id !== group.group.owner ||
      createdProjects.get(after.project_id) !==
        JSON.stringify([group.group.owner, group.group.targetName])
    )
      fail();
    count("chats", after.id);
  };
  const validateAssociation = (name: TableImage["name"], row: RowImage) => {
    if (row.before === null || row.after !== null) fail();
    const before = object({ id: string() }).parse(JSON.parse(row.before!));
    const expected =
      name === "workflow_automations" ? deleted : deletedBindings;
    if (!expected.has(before.id)) fail();
    count(name, before.id);
  };
  const validateRun = (row: RowImage) => {
    if (row.before === null || row.after === null) fail();
    const before = object({
      id: string(),
      workflow_automation_id: string(),
    }).parse(JSON.parse(row.before!));
    object({ workflow_automation_id: literal(null) }).parse(
      JSON.parse(row.after!),
    );
    if (
      !deleted.has(before.workflow_automation_id) ||
      !image.runIds.includes(before.id)
    )
      fail();
    count("runs", before.id);
  };
  const validateReadonly = () => {
    fail();
  };
  const validateDependency = (row: RowImage) => {
    if (row.before === null || row.after !== null) fail();
    const before = object({ automation_id: string() }).parse(
      JSON.parse(row.before!),
    );
    if (!deleted.has(before.automation_id)) fail();
  };
  const validateChange = (name: TableImage["name"], row: RowImage) => {
    switch (name) {
      case "workflows":
        validateWorkflow(row);
        break;
      case "instructions":
        validatePersonal(row);
        break;
      case "chat_threads":
        validateChat(row);
        break;
      case "workflow_automations":
      case "workflow_user_automation_threads":
        validateAssociation(name, row);
        break;
      case "agent_runs":
        validateRun(row);
        break;
      case "agents":
      case "org_metadata":
      case "org_members_cache":
      case "official_workflow_automation_identities":
        validateReadonly();
        break;
      default:
        validateDependency(row);
    }
  };
  const validateKeys = (table: TableImage, row: RowImage) => {
    const key = record(string(), unknown()).parse(JSON.parse(row.key));
    for (const text of [row.before, row.after]) {
      if (text === null) continue;
      const body = record(string(), unknown()).parse(JSON.parse(text));
      if (
        Object.keys(key).length !== table.keys.length ||
        table.keys.some((field) => {
          return key[field] !== body[field];
        })
      )
        fail();
      if (body.org_id !== undefined && body.org_id !== image.scope.orgId)
        fail();
    }
  };
  const indexProjects = () => {
    for (const row of image.tables.find((table) => {
      return table.name === "projects";
    })?.rows ?? []) {
      if (row.before === row.after) continue;
      if (row.before !== null || row.after === null) fail();
      const value = object({
        id: string(),
        org_id: string(),
        user_id: string(),
        name: string(),
      }).parse(JSON.parse(row.after!));
      const groupKey = JSON.stringify([value.user_id, value.name]);
      if (value.org_id !== image.scope.orgId || !groups.has(groupKey)) fail();
      createdProjects.set(value.id, groupKey);
      count("projects", groupKey);
    }
  };
  indexProjects();
  for (const table of image.tables) {
    if (
      new Set(
        table.rows.map((row) => {
          return row.key;
        }),
      ).size !== table.rows.length
    )
      fail();
    for (const row of table.rows) {
      validateKeys(table, row);
      if (row.before === row.after || table.name === "projects") continue;
      validateChange(table.name, row);
    }
  }
  const expectedCounts = {
    moves: moves.size,
    conversions: conversions.size,
    initializations: initializations.size,
    projects: groups.size,
    chats: chats.size,
    workflow_automations: deleted.size,
    workflow_user_automation_threads: deletedBindings.size,
    runs: image.runIds.length,
  };
  for (const [kind, expected] of Object.entries(expectedCounts))
    if ((counted.get(kind)?.size ?? 0) !== expected) fail();
  if (new Set(image.runIds).size !== image.runIds.length) fail();
}
