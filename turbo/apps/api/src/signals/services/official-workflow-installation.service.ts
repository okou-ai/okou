import {
  workflowAutomationCreateRequestSchema,
  type WorkflowAutomationCreateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowBlueprintBindings,
  OfficialWorkflowInstallationParameter,
  OfficialWorkflowParameterBinding,
  OfficialWorkflowParameterValue,
  OfficialWorkflowTemplateJsonValue,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { isValidTimeZone } from "@okouai/core/timezone";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { iso } from "zod";

import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle, settleIncludingAbort } from "../utils";
import { AUTONOMY_BUDGET_CEILING } from "../autonomy-budget-limit";
import { deleteWorkflow$ } from "./workflow-delete.service";
import {
  createWorkflowAutomation$,
  type AutomationResult,
  type CreateAutomationInput,
} from "./workflow-automation.service";
import type { WorkflowMember } from "./workflow-data.service";
import { withMorningBriefCronBinding } from "./official-workflow-owner-schedule";
import { builtInWorkflow } from "./builtin-workflows";

const STALE_INSTALLATION_AGE_MS = 5 * 60 * 1000;

type OfficialWorkflowFailure =
  | { readonly kind: "bad-request"; readonly message: string }
  | { readonly kind: "not-found"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

export type OfficialWorkflowInstallResult =
  | { readonly kind: "ok"; readonly workflowId: string }
  | OfficialWorkflowFailure;

export interface ResolvedBlueprint {
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly bindings: readonly OfficialWorkflowParameterBinding[];
  readonly createRequest: WorkflowAutomationCreateRequest;
  readonly autonomyBudget: number | undefined;
}

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

/** Resolve persisted bindings with the same defaults the editable copy will use. */
export function canCopyInstalledBlueprint(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  existing: readonly OfficialWorkflowParameterBinding[],
  timezone: string | null,
): boolean {
  const values = new Map<string, OfficialWorkflowParameterValue>();
  for (const binding of existing) {
    const parameter = blueprint.parameters.find((candidate) => {
      return candidate.key === binding.key;
    });
    if (parameter && validParameterValue(parameter, binding.value)) {
      values.set(binding.key, binding.value);
    }
  }
  const bindings = Array.from(values, ([key, value]) => {
    return { key, value };
  });
  return resolveBlueprint(
    blueprint,
    { blueprintKey: blueprint.key, bindings },
    timezone,
  ).ok;
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
      message: "Official Workflow is already installed for this member",
    };
  },
);

interface InstallOfficialWorkflowArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly definitionName: string;
  readonly blueprints: readonly OfficialWorkflowBlueprintBindings[];
}

type ResolvedInstallation = Extract<ResolveResult, { readonly ok: true }>;

const resolveInstallation$ = command(
  async (
    { get },
    args: InstallOfficialWorkflowArgs,
    signal: AbortSignal,
  ): Promise<ResolvedInstallation | OfficialWorkflowFailure> => {
    const builtin = builtInWorkflow(args.definitionName);
    if (!builtin || builtin.definition.name !== args.definitionName) {
      return {
        kind: "not-found",
        message: `Official Workflow not found: ${args.definitionName}`,
      };
    }
    const { revision } = builtin;
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
      ? resolved
      : { kind: "bad-request", message: resolved.message };
  },
);

const insertInstallingWorkflow$ = command(
  async (
    { set },
    args: {
      readonly installation: InstallOfficialWorkflowArgs;
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
          name: args.installation.definitionName,
          visibility: "private",
          instruction: null,
          ownerUserId: args.installation.member.userId,
          displayName: null,
          description: null,
          officialDefinitionName: args.installation.definitionName,
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
          "idx_workflows_official_owner_definition_unique",
        ) ||
        isUniqueViolation(
          inserted.error,
          "idx_workflows_morning_brief_owner_unique",
        )
      ) {
        return {
          kind: "conflict",
          message:
            "Official Workflow installation is in progress or already installed for this member",
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
    const [installed] = await db
      .update(workflows)
      .set({ officialInstallationState: "installed", updatedAt: nowDate() })
      .where(
        and(
          eq(workflows.id, args.workflowId),
          eq(
            workflows.officialDefinitionName,
            args.installation.definitionName,
          ),
          eq(workflows.officialInstallationState, "installing"),
          eq(workflows.orgId, args.installation.orgId),
          eq(workflows.ownerUserId, args.installation.member.userId),
        ),
      )
      .returning({ id: workflows.id });
    signal.throwIfAborted();
    return installed !== undefined;
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
    for (const resolvedBlueprint of args.resolved.blueprints) {
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
          definitionName: args.installation.definitionName,
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
    if (!activation) {
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
    const resolved = await set(resolveInstallation$, args, signal);
    if ("kind" in resolved) {
      return resolved;
    }
    const currentTime = nowDate();
    const existing = await set(
      recoverOrRejectExistingInstallation$,
      {
        orgId: args.orgId,
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
