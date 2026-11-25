import { workflowAutomationCreateRequestSchema } from "@okouai/api-contracts/contracts/workflows";
import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowInstallationParameter,
  OfficialWorkflowParameterBinding,
  OfficialWorkflowParameterValue,
  OfficialWorkflowTemplateJsonValue,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { isValidTimeZone } from "@okouai/core/timezone";
import { int, iso } from "zod";
import { AUTONOMY_BUDGET_CEILING } from "../autonomy-budget-limit";

const copyAutonomyBudgetSchema = int()
  .min(0)
  .max(AUTONOMY_BUDGET_CEILING)
  .optional();

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

/** JSON has no undefined value. An undefined result means a template parameter is missing. */
function materializeTemplate(
  value: OfficialWorkflowTemplateJsonValue,
  bindings: ReadonlyMap<string, OfficialWorkflowParameterValue>,
): unknown {
  if (isParameterReference(value)) {
    return bindings.get(value.parameter);
  }
  if (Array.isArray(value)) {
    const items = value.map((item: OfficialWorkflowTemplateJsonValue) => {
      return materializeTemplate(item, bindings);
    });
    return items.includes(undefined) ? undefined : items;
  }
  if (isJsonObject(value)) {
    const materialized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = materializeTemplate(
        item as OfficialWorkflowTemplateJsonValue,
        bindings,
      );
      if (resolved === undefined) {
        return undefined;
      }
      materialized[key] = resolved;
    }
    return materialized;
  }
  return value;
}

/** Validate the archived Blueprint with the installed automation's bindings and timezone. */
export function canCopyInstalledBlueprint(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  existing: readonly OfficialWorkflowParameterBinding[],
  timezone: string | null,
): boolean {
  const stored = new Map<string, OfficialWorkflowParameterValue>();
  for (const binding of existing) {
    const parameter = blueprint.parameters.find((candidate) => {
      return candidate.key === binding.key;
    });
    if (parameter && validParameterValue(parameter, binding.value)) {
      stored.set(binding.key, binding.value);
    }
  }
  const values = new Map<string, OfficialWorkflowParameterValue>();
  for (const parameter of blueprint.parameters) {
    const value = stored.get(parameter.key) ?? parameter.default;
    if (value === undefined) {
      if (parameter.required) {
        return false;
      }
    } else {
      if (!validParameterValue(parameter, value)) {
        return false;
      }
      values.set(parameter.key, value);
    }
  }
  const desired = materializeTemplate(
    blueprint.desiredState as OfficialWorkflowTemplateJsonValue,
    values,
  );
  if (!isJsonObject(desired)) {
    return false;
  }
  const { autonomyBudget, ...request } = desired;
  if (!copyAutonomyBudgetSchema.safeParse(autonomyBudget).success) {
    return false;
  }
  const schedule = request.schedule;
  if (
    request.kind === "schedule" &&
    isJsonObject(schedule) &&
    (schedule.type === "cron" || schedule.type === "once") &&
    schedule.timezone === undefined
  ) {
    if (!timezone || !isValidTimeZone(timezone)) {
      return false;
    }
    request.schedule = { ...schedule, timezone };
  }
  return workflowAutomationCreateRequestSchema.safeParse({
    ...request,
    enabled: true,
  }).success;
}
