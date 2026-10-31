import {
  workflowAutomationCreateRequestSchema,
  type WorkflowAutomationCreateRequest,
  type WorkflowSchedule,
} from "@okouai/api-contracts/contracts/workflows";
import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowBlueprintBindings,
  OfficialWorkflowInstallationParameter,
  OfficialWorkflowParameterBinding,
  OfficialWorkflowParameterValue,
  OfficialWorkflowTemplateJsonValue,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { isValidTimeZone, parseScheduledAtTime } from "@okouai/core/timezone";
import {
  officialWorkflowCatalogState,
  officialWorkflowCatalogReleases,
} from "@okouai/db/schema/official-workflow-catalog";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq, exists, sql } from "drizzle-orm";
import { iso } from "zod";

import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { safeSync, settle, settleIncludingAbort } from "../utils";
import { AUTONOMY_BUDGET_CEILING } from "../autonomy-budget-limit";
import { deleteWorkflow$ } from "./workflow-delete.service";
import {
  acceptedCatalogFromRow,
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  createWorkflowAutomation$,
  type AutomationResult,
  type CreateAutomationInput,
  type OfficialAutomationEventPreparation,
} from "./workflow-automation.service";
import type { WorkflowMember } from "./workflow-data.service";
import { calculateNextRun } from "./time-automation";
import { withMorningBriefCronBinding } from "./official-workflow-owner-schedule";

const STALE_INSTALLATION_AGE_MS = 5 * 60 * 1000;

type OfficialWorkflowFailure =
  | { readonly kind: "bad-request"; readonly message: string }
  | { readonly kind: "not-found"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

export type OfficialWorkflowInstallResult =
  | { readonly kind: "ok"; readonly workflowId: string }
  | OfficialWorkflowFailure;

interface ConfigurableAgent {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
}

export interface ResolvedBlueprint {
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly bindings: readonly OfficialWorkflowParameterBinding[];
  readonly createRequest: WorkflowAutomationCreateRequest;
  readonly autonomyBudget: number | undefined;
}

type OfficialWorkflowBlueprintReconciliationResolution =
  | {
      readonly ok: true;
      readonly resolved: ResolvedBlueprint;
    }
  | {
      readonly ok: false;
      readonly bindings: readonly OfficialWorkflowParameterBinding[];
      readonly message: string;
    };

type ResolveResult =
  | { readonly ok: true; readonly blueprints: readonly ResolvedBlueprint[] }
  | { readonly ok: false; readonly message: string };

function isParameterReference(
  value: unknown,
): value is { readonly parameter: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "parameter" in value &&
    typeof value.parameter === "string"
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStringParameterValue(
  parameter: Extract<
    OfficialWorkflowInstallationParameter,
    { readonly type: "string" }
  >,
  value: string,
): boolean {
  if (parameter.format === "uuid") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
  if (parameter.format === "timezone") {
    return isValidTimeZone(value);
  }
  if (parameter.format === "date-time") {
    return iso.datetime({ offset: true }).safeParse(value).success;
  }
  if (parameter.format === "url") {
    return URL.canParse(value);
  }
  return true;
}

function validParameterValue(
  parameter: OfficialWorkflowInstallationParameter,
  value: OfficialWorkflowParameterValue,
): boolean {
  if (parameter.type === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value);
  }
  if (parameter.type === "boolean") {
    return typeof value === "boolean";
  }
  return (
    typeof value === "string" && validStringParameterValue(parameter, value)
  );
}

function resolveParameterBindings(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  supplied: OfficialWorkflowBlueprintBindings,
):
  | {
      readonly ok: true;
      readonly bindings: readonly OfficialWorkflowParameterBinding[];
    }
  | { readonly ok: false; readonly message: string } {
  const parameters = new Map(
    blueprint.parameters.map((parameter) => {
      return [parameter.key, parameter] as const;
    }),
  );
  const suppliedByKey = new Map<string, OfficialWorkflowParameterValue>();
  for (const binding of supplied.bindings) {
    if (suppliedByKey.has(binding.key)) {
      return {
        ok: false,
        message: `Duplicate parameter binding: ${blueprint.key}.${binding.key}`,
      };
    }
    const parameter = parameters.get(binding.key);
    if (!parameter) {
      return {
        ok: false,
        message: `Unknown parameter: ${blueprint.key}.${binding.key}`,
      };
    }
    if (!validParameterValue(parameter, binding.value)) {
      return {
        ok: false,
        message: `Invalid value for parameter: ${blueprint.key}.${binding.key}`,
      };
    }
    suppliedByKey.set(binding.key, binding.value);
  }

  const bindings: OfficialWorkflowParameterBinding[] = [];
  for (const parameter of blueprint.parameters) {
    let value = suppliedByKey.get(parameter.key);
    if (value === undefined && parameter.default !== undefined) {
      value = parameter.default;
    }
    if (value === undefined) {
      if (parameter.required) {
        return {
          ok: false,
          message: `Missing parameter: ${blueprint.key}.${parameter.key}`,
        };
      }
      continue;
    }
    if (!validParameterValue(parameter, value)) {
      return {
        ok: false,
        message: `Invalid value for parameter: ${blueprint.key}.${parameter.key}`,
      };
    }
    bindings.push({ key: parameter.key, value });
  }
  return { ok: true, bindings };
}

function materializeTemplate(
  value: OfficialWorkflowTemplateJsonValue,
  bindings: ReadonlyMap<string, OfficialWorkflowParameterValue>,
):
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly parameter: string;
    } {
  if (isParameterReference(value)) {
    const resolved = bindings.get(value.parameter);
    return resolved === undefined
      ? { ok: false, parameter: value.parameter }
      : { ok: true, value: resolved };
  }
  if (Array.isArray(value)) {
    const materialized: unknown[] = [];
    for (const item of value) {
      const result = materializeTemplate(item, bindings);
      if (!result.ok) {
        return result;
      }
      materialized.push(result.value);
    }
    return { ok: true, value: materialized };
  }
  if (isJsonObject(value)) {
    const materialized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = materializeTemplate(
        item as OfficialWorkflowTemplateJsonValue,
        bindings,
      );
      if (!result.ok) {
        return result;
      }
      materialized[key] = result.value;
    }
    return { ok: true, value: materialized };
  }
  return { ok: true, value };
}

function withScheduleTimezoneDefault(
  desiredState: Record<string, unknown>,
  defaultTimezone: string | null,
  blueprintKey: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string } {
  if (
    desiredState.kind !== "schedule" ||
    !isJsonObject(desiredState.schedule) ||
    (desiredState.schedule.type !== "cron" &&
      desiredState.schedule.type !== "once") ||
    desiredState.schedule.timezone !== undefined
  ) {
    return { ok: true, value: desiredState };
  }
  if (!defaultTimezone || !isValidTimeZone(defaultTimezone)) {
    return {
      ok: false,
      message: `A valid user timezone preference is required for Blueprint: ${blueprintKey}`,
    };
  }
  return {
    ok: true,
    value: {
      ...desiredState,
      schedule: { ...desiredState.schedule, timezone: defaultTimezone },
    },
  };
}

export function resolveBlueprint(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  supplied: OfficialWorkflowBlueprintBindings,
  defaultTimezone: string | null,
):
  | { readonly ok: true; readonly blueprint: ResolvedBlueprint }
  | { readonly ok: false; readonly message: string } {
  const resolvedBindings = resolveParameterBindings(blueprint, supplied);
  if (!resolvedBindings.ok) {
    return resolvedBindings;
  }
  const bindingValues = new Map(
    resolvedBindings.bindings.map((binding) => {
      return [binding.key, binding.value] as const;
    }),
  );
  const desired = materializeTemplate(
    blueprint.desiredState as OfficialWorkflowTemplateJsonValue,
    bindingValues,
  );
  if (!desired.ok) {
    return {
      ok: false,
      message: `Missing parameter used by Blueprint: ${blueprint.key}.${desired.parameter}`,
    };
  }
  if (!isJsonObject(desired.value)) {
    return { ok: false, message: `Invalid Blueprint: ${blueprint.key}` };
  }
  const desiredWithTimezone = withScheduleTimezoneDefault(
    desired.value,
    defaultTimezone,
    blueprint.key,
  );
  if (!desiredWithTimezone.ok) {
    return desiredWithTimezone;
  }
  const { autonomyBudget, ...createDesiredState } = desiredWithTimezone.value;
  if (
    autonomyBudget !== undefined &&
    (typeof autonomyBudget !== "number" ||
      !Number.isSafeInteger(autonomyBudget) ||
      autonomyBudget < 0 ||
      autonomyBudget > AUTONOMY_BUDGET_CEILING)
  ) {
    return {
      ok: false,
      message: `Invalid autonomy budget for Blueprint: ${blueprint.key}`,
    };
  }
  const parsed = workflowAutomationCreateRequestSchema.safeParse({
    ...createDesiredState,
    enabled: true,
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: `Invalid desired state for Blueprint: ${blueprint.key}`,
    };
  }
  return {
    ok: true,
    blueprint: {
      blueprint,
      bindings: resolvedBindings.bindings,
      createRequest: parsed.data,
      autonomyBudget:
        typeof autonomyBudget === "number" ? autonomyBudget : undefined,
    },
  };
}

/**
 * Resolve one current Blueprint from a prior Installation projection. Values
 * for removed or now-invalid parameter keys are deliberately discarded before
 * current defaults are applied.
 */
function reconciliationParameterValues(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  existing: readonly OfficialWorkflowParameterBinding[],
): ReadonlyMap<string, OfficialWorkflowParameterValue> {
  const parameters = new Map(
    blueprint.parameters.map((parameter) => {
      return [parameter.key, parameter] as const;
    }),
  );
  const values = new Map<string, OfficialWorkflowParameterValue>();
  for (const binding of existing) {
    const parameter = parameters.get(binding.key);
    if (parameter && validParameterValue(parameter, binding.value)) {
      values.set(binding.key, binding.value);
    }
  }
  return values;
}

export function resolveOfficialWorkflowBlueprintForReconciliation(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  existing: readonly OfficialWorkflowParameterBinding[],
  defaultTimezone: string | null,
): OfficialWorkflowBlueprintReconciliationResolution {
  const parameterValues = reconciliationParameterValues(blueprint, existing);

  const bindings: OfficialWorkflowParameterBinding[] = [];
  let unresolvedMessage: string | undefined;
  for (const parameter of blueprint.parameters) {
    let value = parameterValues.get(parameter.key);
    if (value === undefined && parameter.default !== undefined) {
      value = parameter.default;
    }
    if (value === undefined) {
      if (parameter.required && unresolvedMessage === undefined) {
        unresolvedMessage = `Missing parameter: ${blueprint.key}.${parameter.key}`;
      }
      continue;
    }
    bindings.push({ key: parameter.key, value });
  }
  if (unresolvedMessage !== undefined) {
    return { ok: false, bindings, message: unresolvedMessage };
  }
  const resolved = resolveBlueprint(
    blueprint,
    { blueprintKey: blueprint.key, bindings },
    defaultTimezone,
  );
  return resolved.ok
    ? { ok: true, resolved: resolved.blueprint }
    : { ok: false, bindings, message: resolved.message };
}

function resolveAllBlueprints(
  blueprints: readonly OfficialWorkflowAcceptedBlueprint[],
  supplied: readonly OfficialWorkflowBlueprintBindings[],
  defaultTimezone: string | null,
): ResolveResult {
  const suppliedByKey = new Map<string, OfficialWorkflowBlueprintBindings>();
  for (const entry of supplied) {
    if (suppliedByKey.has(entry.blueprintKey)) {
      return {
        ok: false,
        message: `Duplicate Blueprint bindings: ${entry.blueprintKey}`,
      };
    }
    suppliedByKey.set(entry.blueprintKey, entry);
  }
  const declaredKeys = new Set(
    blueprints.map((blueprint) => {
      return blueprint.key;
    }),
  );
  for (const suppliedKey of suppliedByKey.keys()) {
    if (!declaredKeys.has(suppliedKey)) {
      return { ok: false, message: `Unknown Blueprint: ${suppliedKey}` };
    }
  }
  if (suppliedByKey.size !== blueprints.length) {
    const missing = blueprints.find((blueprint) => {
      return !suppliedByKey.has(blueprint.key);
    });
    return {
      ok: false,
      message: `Missing Blueprint bindings: ${missing?.key ?? "unknown"}`,
    };
  }
  const resolved: ResolvedBlueprint[] = [];
  for (const blueprint of blueprints) {
    const entry = suppliedByKey.get(blueprint.key);
    if (!entry) {
      throw new Error("Resolved Blueprint binding disappeared");
    }
    const result = resolveBlueprint(blueprint, entry, defaultTimezone);
    if (!result.ok) {
      return result;
    }
    resolved.push(result.blueprint);
  }
  return { ok: true, blueprints: resolved };
}

const loadConfigurableAgent$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly agentId: string;
      readonly member: WorkflowMember;
    },
    signal: AbortSignal,
  ): Promise<ConfigurableAgent | OfficialWorkflowFailure> => {
    const [agent] = await get(db$)
      .select({
        id: agents.id,
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return { kind: "not-found", message: `Agent not found: ${args.agentId}` };
    }
    if (agent.visibility === "private" && agent.owner !== args.member.userId) {
      return {
        kind: "forbidden",
        message:
          "Only the private agent owner can install Official Workflows on this agent",
      };
    }
    return agent;
  },
);

function isFailure(
  value: ConfigurableAgent | OfficialWorkflowFailure,
): value is OfficialWorkflowFailure {
  return "kind" in value;
}

export const loadOfficialWorkflowUserTimezone$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ timezone: orgMembersMetadata.timezone })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row?.timezone ?? null;
  },
);

const recoverOrRejectExistingInstallation$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly agentId: string;
      readonly userId: string;
      readonly definitionName: string;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowFailure | null> => {
    const [existing] = await get(db$)
      .select({
        id: workflows.id,
        officialInstallationState: workflows.officialInstallationState,
        createdAt: workflows.createdAt,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, args.orgId),
          eq(workflows.agentId, args.agentId),
          eq(workflows.ownerUserId, args.userId),
          eq(workflows.visibility, "private"),
          eq(workflows.officialDefinitionName, args.definitionName),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!existing) {
      return null;
    }
    if (
      existing.officialInstallationState === "installing" &&
      args.currentTime.getTime() - existing.createdAt.getTime() >=
        STALE_INSTALLATION_AGE_MS
    ) {
      return (await set(
        cleanupInstallation$,
        { orgId: args.orgId, workflowId: existing.id },
        signal,
      ))
        ? null
        : {
            kind: "conflict",
            message:
              "Official Workflow installation changed during recovery; retry",
          };
    }
    if (existing.officialInstallationState === "installing") {
      return {
        kind: "conflict",
        message: "Official Workflow installation is in progress",
      };
    }
    return {
      kind: "conflict",
      message: "Official Workflow is already installed on this agent",
    };
  },
);

function sameAcceptedDefinition(
  expectedReleaseId: string,
  expected: OfficialWorkflowAcceptedDefinition,
  current: AcceptedOfficialWorkflowCatalog | null,
): boolean {
  if (!current || current.releaseId !== expectedReleaseId) {
    return false;
  }
  const definition = current.payload.definitions.find((entry) => {
    return entry.name === expected.name;
  });
  return (
    definition?.lifecycle === expected.lifecycle &&
    definition.revision === expected.revision &&
    definition.blueprints.length === expected.blueprints.length &&
    definition.blueprints.every((blueprint, index) => {
      const accepted = expected.blueprints[index];
      return (
        accepted !== undefined &&
        blueprint.key === accepted.key &&
        blueprint.fingerprint === accepted.fingerprint
      );
    })
  );
}

interface InstallOfficialWorkflowArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly agentId: string;
  readonly definitionName: string;
  readonly blueprints: readonly OfficialWorkflowBlueprintBindings[];
}

interface ResolvedInstallation {
  readonly catalog: AcceptedOfficialWorkflowCatalog;
  readonly definition: OfficialWorkflowAcceptedDefinition;
  readonly resolved: Extract<ResolveResult, { readonly ok: true }>;
}

const resolveInstallation$ = command(
  async (
    { get, set },
    args: InstallOfficialWorkflowArgs,
    signal: AbortSignal,
  ): Promise<ResolvedInstallation | OfficialWorkflowFailure> => {
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = catalog?.payload.definitions.find((entry) => {
      return entry.name === args.definitionName;
    });
    if (!catalog || !definition) {
      return {
        kind: "not-found",
        message: `Official Workflow not found: ${args.definitionName}`,
      };
    }
    if (definition.lifecycle !== "active") {
      return {
        kind: "conflict",
        message: `Official Workflow is retired: ${args.definitionName}`,
      };
    }
    const revision = await set(
      readAcceptedOfficialWorkflowRevision$,
      { name: definition.name, revision: definition.revision },
      signal,
    );
    if (!revision) {
      throw new Error("Accepted Official Workflow revision is missing");
    }
    const [metadata] = await get(db$)
      .select({ timezone: orgMembersMetadata.timezone })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.member.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const userTimezone = metadata?.timezone ?? null;
    const owner = { orgId: args.orgId, userId: args.member.userId };
    const supplied = args.blueprints.map((entry) => {
      const blueprint = revision.definition.blueprints.find((candidate) => {
        return candidate.key === entry.blueprintKey;
      });
      return blueprint
        ? {
            ...entry,
            bindings: withMorningBriefCronBinding({
              definitionName: args.definitionName,
              blueprint,
              owner,
              bindings: entry.bindings,
            }),
          }
        : entry;
    });
    const resolved = resolveAllBlueprints(
      revision.definition.blueprints,
      supplied,
      userTimezone,
    );
    return resolved.ok
      ? { catalog, definition, resolved }
      : { kind: "bad-request", message: resolved.message };
  },
);

const insertInstallingWorkflow$ = command(
  async (
    { set },
    args: {
      readonly installation: InstallOfficialWorkflowArgs;
      readonly agentId: string;
      readonly definition: OfficialWorkflowAcceptedDefinition;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "ok"; readonly workflowId: string }
    | OfficialWorkflowFailure
  > => {
    const inserted = await settle(
      set(writeDb$)
        .insert(workflows)
        .values({
          orgId: args.installation.orgId,
          agentId: args.agentId,
          name: args.definition.name,
          visibility: "private",
          instruction: null,
          ownerUserId: args.installation.member.userId,
          displayName: null,
          description: null,
          officialDefinitionName: args.definition.name,
          officialInstallationState: "installing",
          createdBy: args.installation.member.userId,
          updatedBy: args.installation.member.userId,
          createdAt: args.currentTime,
          updatedAt: args.currentTime,
        })
        .returning({ id: workflows.id }),
      signal,
    );
    if (!inserted.ok) {
      if (
        isUniqueViolation(
          inserted.error,
          "idx_workflows_official_owner_agent_definition_unique",
        ) ||
        isUniqueViolation(
          inserted.error,
          "idx_workflows_morning_brief_owner_agent_unique",
        )
      ) {
        return {
          kind: "conflict",
          message:
            "Official Workflow installation is in progress or already installed on this agent",
        };
      }
      if (
        isUniqueViolation(
          inserted.error,
          "idx_workflows_private_owner_agent_name_unique",
        )
      ) {
        return {
          kind: "conflict",
          message: `A private workflow named "${args.definition.name}" already exists on this agent`,
        };
      }
      throw inserted.error;
    }
    const workflow = inserted.value[0];
    if (!workflow) {
      throw new Error("Failed to create Official Workflow installation");
    }
    return { kind: "ok", workflowId: workflow.id };
  },
);

function automationFailure(
  automation: Exclude<AutomationResult, { readonly kind: "ok" }>,
): OfficialWorkflowFailure {
  return {
    kind:
      automation.kind === "forbidden"
        ? "forbidden"
        : automation.kind === "not-found"
          ? "not-found"
          : automation.kind === "conflict"
            ? "conflict"
            : "bad-request",
    message:
      "message" in automation
        ? automation.message
        : "Official Workflow automation could not be created",
  };
}

interface InstallationCompletion {
  readonly installation: InstallOfficialWorkflowArgs;
  readonly resolved: ResolvedInstallation;
  readonly workflowId: string;
}
const activateInstallation$ = command(
  async ({ set }, args: InstallationCompletion, signal: AbortSignal) => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [catalogRow] = await db
      .select({
        releaseId: officialWorkflowCatalogState.acceptedReleaseId,
        payload: officialWorkflowCatalogReleases.payload,
        hiddenThreadDefinitionNames:
          officialWorkflowCatalogReleases.hiddenThreadDefinitionNames,
      })
      .from(officialWorkflowCatalogState)
      .innerJoin(
        officialWorkflowCatalogReleases,
        eq(
          officialWorkflowCatalogReleases.id,
          officialWorkflowCatalogState.acceptedReleaseId,
        ),
      )
      .where(
        eq(
          officialWorkflowCatalogState.authority,
          OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !sameAcceptedDefinition(
        args.resolved.catalog.releaseId,
        args.resolved.definition,
        acceptedCatalogFromRow(catalogRow),
      )
    ) {
      return "stale" as const;
    }

    // Recheck the validated immutable release while retaining the existing
    // catalog -> Agent lock order through the installing -> installed write.
    const catalog = db.$with("activation_catalog").as(
      db
        .select({ authority: officialWorkflowCatalogState.authority })
        .from(officialWorkflowCatalogState)
        .where(
          and(
            eq(
              officialWorkflowCatalogState.authority,
              OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
            ),
            eq(
              officialWorkflowCatalogState.acceptedReleaseId,
              args.resolved.catalog.releaseId,
            ),
          ),
        )
        .for("share"),
    );
    const agent = db.$with("activation_agent").as(
      db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, args.installation.agentId),
            eq(agents.orgId, args.installation.orgId),
            exists(db.select({ authority: catalog.authority }).from(catalog)),
          ),
        )
        .for("key share")
        .limit(1),
    );
    const installed = db.$with("activated_installation").as(
      db
        .update(workflows)
        .set({ officialInstallationState: "installed", updatedAt: nowDate() })
        .where(
          and(
            eq(workflows.id, args.workflowId),
            eq(workflows.officialInstallationState, "installing"),
            exists(db.select({ id: agent.id }).from(agent)),
          ),
        )
        .returning({ id: workflows.id }),
    );
    const [activation] = await db
      .with(catalog, agent, installed)
      .select({ agentId: agent.id, installedId: installed.id })
      .from(catalog)
      .leftJoin(agent, sql`true`)
      .leftJoin(installed, sql`true`);
    signal.throwIfAborted();
    if (!activation) {
      return "stale" as const;
    }
    return activation.installedId ? ("installed" as const) : ("lost" as const);
  },
);
const cleanupInstallation$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly workflowId: string },
    _signal: AbortSignal,
  ) => {
    // Cleanup owns an independent lifetime after installation has reserved resources.
    const cleanupSignal = new AbortController().signal;
    return await set(
      deleteWorkflow$,
      {
        ...args,
        allowOfficialInstallationDeletion: true,
        requiredOfficialInstallationState: "installing",
      },
      cleanupSignal,
    );
  },
);
const completeInstallation$ = command(
  async (
    { set },
    args: InstallationCompletion,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowInstallResult> => {
    for (const resolvedBlueprint of args.resolved.resolved.blueprints) {
      const input: CreateAutomationInput = {
        ...resolvedBlueprint.createRequest,
        orgId: args.installation.orgId,
        member: args.installation.member,
        workflowId: args.workflowId,
        enabled: true,
        ...(resolvedBlueprint.autonomyBudget === undefined
          ? {}
          : { autonomyBudget: resolvedBlueprint.autonomyBudget }),
        officialInstallation: {
          definitionName: args.resolved.definition.name,
          blueprintKey: resolvedBlueprint.blueprint.key,
          appliedFingerprint: resolvedBlueprint.blueprint.fingerprint,
          parameterBindings: resolvedBlueprint.bindings,
        },
      };
      const automation = await set(createWorkflowAutomation$, input, signal);
      signal.throwIfAborted();
      if (automation.kind !== "ok") {
        await set(
          cleanupInstallation$,
          { orgId: args.installation.orgId, workflowId: args.workflowId },
          signal,
        );
        return automationFailure(automation);
      }
    }
    const activation = await set(activateInstallation$, args, signal);
    signal.throwIfAborted();
    if (activation === "stale") {
      await set(
        cleanupInstallation$,
        { orgId: args.installation.orgId, workflowId: args.workflowId },
        signal,
      );
      return {
        kind: "conflict",
        message: "Official Workflow changed during installation; retry",
      };
    }
    if (activation === "lost") {
      await set(
        cleanupInstallation$,
        { orgId: args.installation.orgId, workflowId: args.workflowId },
        signal,
      );
      return {
        kind: "conflict",
        message: "Official Workflow installation lost ownership; retry",
      };
    }
    return { kind: "ok", workflowId: args.workflowId };
  },
);

export const installOfficialWorkflow$ = command(
  async (
    { set },
    args: InstallOfficialWorkflowArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowInstallResult> => {
    const agent = await set(loadConfigurableAgent$, args, signal);
    signal.throwIfAborted();
    if (isFailure(agent)) {
      return agent;
    }
    const resolved = await set(resolveInstallation$, args, signal);
    if ("kind" in resolved) {
      return resolved;
    }
    const currentTime = nowDate();
    const existing = await set(
      recoverOrRejectExistingInstallation$,
      {
        orgId: args.orgId,
        agentId: agent.id,
        userId: args.member.userId,
        definitionName: args.definitionName,
        currentTime,
      },
      signal,
    );
    signal.throwIfAborted();
    if (existing) {
      return existing;
    }
    const inserted = await set(
      insertInstallingWorkflow$,
      {
        installation: args,
        agentId: agent.id,
        definition: resolved.definition,
        currentTime,
      },
      signal,
    );
    if (inserted.kind !== "ok") {
      return inserted;
    }
    const completed = await settleIncludingAbort(
      set(
        completeInstallation$,
        {
          installation: args,
          resolved,
          workflowId: inserted.workflowId,
        },
        signal,
      ),
    );
    if (signal.aborted) {
      await set(
        cleanupInstallation$,
        { orgId: args.orgId, workflowId: inserted.workflowId },
        signal,
      );
      if (!completed.ok) {
        throw completed.error;
      }
      signal.throwIfAborted();
    }
    if (!completed.ok) {
      await set(
        cleanupInstallation$,
        { orgId: args.orgId, workflowId: inserted.workflowId },
        signal,
      );
      throw completed.error;
    }
    return completed.value;
  },
);

export type OfficialAutomationRow = typeof workflowAutomations.$inferSelect;

export interface OfficialAutomationPatch {
  readonly kind: "schedule" | "event";
  readonly eventType: OfficialAutomationRow["eventType"];
  readonly eventConfig: OfficialAutomationRow["eventConfig"];
  readonly eventConnectorId: OfficialAutomationRow["eventConnectorId"];
  readonly scheduleType: OfficialAutomationRow["scheduleType"];
  readonly cronExpression: string | null;
  readonly intervalSeconds: number | null;
  readonly atTime: Date | null;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly nextRunAt: Date | null;
  readonly autonomyBudget: number;
  readonly officialAppliedFingerprint: string;
  readonly officialParameterBindings: OfficialWorkflowParameterBinding[];
  readonly officialReconciliationStatus: "reconciling";
  readonly updatedAt: Date;
}

type OfficialAutomationPatchResult =
  | { readonly ok: true; readonly patch: OfficialAutomationPatch }
  | { readonly ok: false; readonly message: string };

function officialPatchMetadata(resolved: ResolvedBlueprint, currentTime: Date) {
  return {
    autonomyBudget: resolved.autonomyBudget ?? AUTONOMY_BUDGET_CEILING,
    officialAppliedFingerprint: resolved.blueprint.fingerprint,
    officialParameterBindings: [...resolved.bindings],
    officialReconciliationStatus: "reconciling" as const,
    updatedAt: currentTime,
  };
}

function eventAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  preparation: OfficialAutomationEventPreparation | undefined,
  currentTime: Date,
): OfficialAutomationPatchResult {
  const request = resolved.createRequest;
  if ("schedule" in request) {
    throw new Error("Official Workflow event patch received a schedule");
  }
  if (!preparation) {
    throw new Error("Official Workflow event preparation disappeared");
  }
  return {
    ok: true,
    patch: {
      kind: "event",
      eventType: request.eventType,
      eventConfig: preparation.eventConfig,
      eventConnectorId: preparation.eventConnectorId ?? null,
      scheduleType: null,
      cronExpression: null,
      intervalSeconds: null,
      atTime: null,
      timezone: "UTC",
      enabled:
        automation.officialIntendedEnabled === true || automation.enabled,
      nextRunAt: null,
      ...officialPatchMetadata(resolved, currentTime),
    },
  };
}

function cronAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  schedule: Extract<WorkflowSchedule, { readonly type: "cron" }>,
  currentTime: Date,
): OfficialAutomationPatchResult {
  if (!isValidTimeZone(schedule.timezone)) {
    return {
      ok: false,
      message: `Invalid timezone for Blueprint: ${resolved.blueprint.key}`,
    };
  }
  const calculated = safeSync(() => {
    return calculateNextRun(
      schedule.cronExpression,
      schedule.timezone,
      currentTime,
    );
  });
  if ("error" in calculated || calculated.ok === null) {
    return {
      ok: false,
      message: `Invalid cron expression for Blueprint: ${resolved.blueprint.key}`,
    };
  }
  return {
    ok: true,
    patch: {
      kind: "schedule",
      eventType: null,
      eventConfig: null,
      eventConnectorId: null,
      scheduleType: "cron",
      cronExpression: schedule.cronExpression,
      intervalSeconds: null,
      atTime: null,
      timezone: schedule.timezone,
      enabled:
        automation.officialIntendedEnabled === true || automation.enabled,
      nextRunAt:
        automation.officialIntendedEnabled === true || automation.enabled
          ? calculated.ok
          : null,
      ...officialPatchMetadata(resolved, currentTime),
    },
  };
}

function onceAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  schedule: Extract<WorkflowSchedule, { readonly type: "once" }>,
  currentTime: Date,
): OfficialAutomationPatchResult {
  const parsed = parseScheduledAtTime(schedule.atTime, schedule.timezone);
  if (
    !parsed.ok ||
    parsed.date.getTime() <= currentTime.getTime() ||
    !isValidTimeZone(schedule.timezone)
  ) {
    return {
      ok: false,
      message: `Invalid one-time schedule for Blueprint: ${resolved.blueprint.key}`,
    };
  }
  return {
    ok: true,
    patch: {
      kind: "schedule",
      eventType: null,
      eventConfig: null,
      eventConnectorId: null,
      scheduleType: "once",
      cronExpression: null,
      intervalSeconds: null,
      atTime: parsed.date,
      timezone: schedule.timezone,
      enabled:
        automation.officialIntendedEnabled === true || automation.enabled,
      nextRunAt:
        automation.officialIntendedEnabled === true || automation.enabled
          ? parsed.date
          : null,
      ...officialPatchMetadata(resolved, currentTime),
    },
  };
}

function loopAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  schedule: Extract<WorkflowSchedule, { readonly type: "loop" }>,
  currentTime: Date,
): OfficialAutomationPatchResult {
  const nextFromLastRun = automation.lastRunAt
    ? new Date(automation.lastRunAt.getTime() + schedule.intervalSeconds * 1000)
    : currentTime;
  const nextRunAt =
    nextFromLastRun.getTime() > currentTime.getTime()
      ? nextFromLastRun
      : currentTime;
  return {
    ok: true,
    patch: {
      kind: "schedule",
      eventType: null,
      eventConfig: null,
      eventConnectorId: null,
      scheduleType: "loop",
      cronExpression: null,
      intervalSeconds: schedule.intervalSeconds,
      atTime: null,
      timezone: "UTC",
      enabled:
        automation.officialIntendedEnabled === true || automation.enabled,
      nextRunAt:
        automation.officialIntendedEnabled === true || automation.enabled
          ? nextRunAt
          : null,
      ...officialPatchMetadata(resolved, currentTime),
    },
  };
}

export function buildOfficialAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  preparation: OfficialAutomationEventPreparation | undefined,
  currentTime: Date,
): OfficialAutomationPatchResult {
  const request = resolved.createRequest;
  if (!("schedule" in request)) {
    return eventAutomationPatch(automation, resolved, preparation, currentTime);
  }
  if (request.schedule.type === "cron") {
    return cronAutomationPatch(
      automation,
      resolved,
      request.schedule,
      currentTime,
    );
  }
  if (request.schedule.type === "once") {
    return onceAutomationPatch(
      automation,
      resolved,
      request.schedule,
      currentTime,
    );
  }
  return loopAutomationPatch(
    automation,
    resolved,
    request.schedule,
    currentTime,
  );
}

export function officialAutomationRestorePatch(
  row: OfficialAutomationRow,
  nextRunAt: Date | null,
  currentTime: Date,
) {
  return {
    kind: row.kind,
    eventType: row.eventType,
    eventConfig: row.eventConfig,
    eventConnectorId: row.eventConnectorId,
    scheduleType: row.scheduleType,
    cronExpression: row.cronExpression,
    intervalSeconds: row.intervalSeconds,
    atTime: row.atTime,
    timezone: row.timezone,
    nextRunAt,
    autonomyBudget: row.autonomyBudget,
    officialBlueprintKey: row.officialBlueprintKey,
    officialAppliedFingerprint: row.officialAppliedFingerprint,
    officialReconciliationStatus: row.officialReconciliationStatus,
    officialParameterBindings: row.officialParameterBindings,
    updatedAt: currentTime,
  };
}

export function refreshOfficialAutomationPatch(
  automation: OfficialAutomationRow,
  patch: OfficialAutomationPatch,
  currentTime: Date,
): OfficialAutomationPatch {
  let nextRunAt: Date | null = null;
  if (patch.enabled && patch.kind === "schedule") {
    if (patch.scheduleType === "cron") {
      if (!patch.cronExpression) {
        throw new Error("Official cron schedule is incomplete");
      }
      nextRunAt = calculateNextRun(
        patch.cronExpression,
        patch.timezone,
        currentTime,
      );
      if (!nextRunAt) {
        throw new Error("Official cron schedule has no next run");
      }
    } else if (patch.scheduleType === "once") {
      if (!patch.atTime) {
        throw new Error("Official one-time schedule is incomplete");
      }
      nextRunAt = patch.atTime;
    } else if (patch.scheduleType === "loop") {
      if (patch.intervalSeconds === null) {
        throw new Error("Official loop schedule is incomplete");
      }
      const nextFromLastRun = automation.lastRunAt
        ? new Date(
            automation.lastRunAt.getTime() + patch.intervalSeconds * 1000,
          )
        : currentTime;
      nextRunAt =
        nextFromLastRun.getTime() > currentTime.getTime()
          ? nextFromLastRun
          : currentTime;
    }
  }
  return { ...patch, nextRunAt, updatedAt: currentTime };
}
