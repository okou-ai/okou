import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowInstallationParameter,
  OfficialWorkflowParameterBinding,
  OfficialWorkflowParameterValue,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import type { WorkflowAutomationSummary } from "@okouai/api-contracts/contracts/workflows";
import { useSet } from "ccstate-react";
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";

import { i18n } from "../../i18n/index.ts";
import {
  setOfficialWorkflowConfigurationAgent$,
  setOfficialWorkflowParameterValue$,
  type OfficialWorkflowConfigurationForm,
} from "../../signals/workflows-page/official-workflows-signals.ts";

interface ConfigurationAgent {
  readonly agentId: string;
  readonly displayName?: string | null;
}

export function officialWorkflowHasConfigurableParameters(
  blueprints: readonly OfficialWorkflowAcceptedBlueprint[],
): boolean {
  return blueprints.some((blueprint) => {
    return blueprint.parameters.length > 0;
  });
}

function parameterInitialValue(
  parameter: OfficialWorkflowInstallationParameter,
  current: ReadonlyMap<string, OfficialWorkflowParameterValue>,
): OfficialWorkflowParameterValue | undefined {
  const currentValue = current.get(parameter.key);
  if (currentValue !== undefined) {
    return currentValue;
  }
  if (parameter.default !== undefined) {
    return parameter.default;
  }
  return undefined;
}

function initialBlueprintBindings(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  current: readonly OfficialWorkflowParameterBinding[],
) {
  const currentByKey = new Map(
    current.map((binding) => {
      return [binding.key, binding.value] as const;
    }),
  );
  return blueprint.parameters.flatMap((parameter) => {
    const value = parameterInitialValue(parameter, currentByKey);
    return value === undefined ? [] : [{ key: parameter.key, value }];
  });
}

export function createOfficialWorkflowConfigurationForm(args: {
  readonly target: OfficialWorkflowConfigurationForm["target"];
  readonly definitionName: string;
  readonly agentId: string;
  readonly blueprints: readonly OfficialWorkflowAcceptedBlueprint[];
  readonly automations?: readonly WorkflowAutomationSummary[];
}): OfficialWorkflowConfigurationForm {
  const automationByBlueprint = new Map(
    (args.automations ?? []).flatMap((automation) => {
      return automation.official
        ? [[automation.official.blueprintKey, automation] as const]
        : [];
    }),
  );
  return {
    target: args.target,
    definitionName: args.definitionName,
    agentId: args.agentId,
    blueprints: args.blueprints.map((blueprint) => {
      const current =
        automationByBlueprint.get(blueprint.key)?.official?.parameterBindings ??
        [];
      return {
        blueprintKey: blueprint.key,
        bindings: initialBlueprintBindings(blueprint, current),
      };
    }),
  };
}

function bindingValue(
  form: OfficialWorkflowConfigurationForm,
  blueprintKey: string,
  parameterKey: string,
): OfficialWorkflowParameterValue | undefined {
  return form.blueprints
    .find((blueprint) => {
      return blueprint.blueprintKey === blueprintKey;
    })
    ?.bindings.find((binding) => {
      return binding.key === parameterKey;
    })?.value;
}

export function officialWorkflowConfigurationComplete(
  form: OfficialWorkflowConfigurationForm,
  blueprints: readonly OfficialWorkflowAcceptedBlueprint[],
): boolean {
  if (!form.agentId) {
    return false;
  }
  return blueprints.every((blueprint) => {
    return blueprint.parameters.every((parameter) => {
      return (
        !parameter.required ||
        bindingValue(form, blueprint.key, parameter.key) !== undefined
      );
    });
  });
}

function ParameterField({
  blueprintKey,
  parameter,
  value,
  disabled,
}: {
  readonly blueprintKey: string;
  readonly parameter: OfficialWorkflowInstallationParameter;
  readonly value: OfficialWorkflowParameterValue | undefined;
  readonly disabled: boolean;
}) {
  const setParameterValue = useSet(setOfficialWorkflowParameterValue$);
  const label = parameter.required
    ? i18n.t(
        ($) => {
          return $.workflows.official.parameterRequired;
        },
        { key: parameter.key },
      )
    : parameter.key;
  if (parameter.type === "boolean") {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Select
          value={typeof value === "boolean" ? String(value) : ""}
          disabled={disabled}
          onValueChange={(next) => {
            setParameterValue({
              blueprintKey,
              parameterKey: parameter.key,
              value:
                next === "true" ? true : next === "false" ? false : undefined,
            });
          }}
        >
          <SelectTrigger className="h-9 w-full" aria-label={label}>
            <SelectValue
              placeholder={i18n.t(($) => {
                return $.workflows.official.chooseValue;
              })}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">
              {i18n.t(($) => {
                return $.workflows.official.yes;
              })}
            </SelectItem>
            <SelectItem value="false">
              {i18n.t(($) => {
                return $.workflows.official.no;
              })}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={`${blueprintKey}-${parameter.key}`}
        className="text-sm font-medium text-foreground"
      >
        {label}
      </label>
      <Input
        id={`${blueprintKey}-${parameter.key}`}
        type={parameter.type === "integer" ? "number" : "text"}
        inputMode={parameter.type === "integer" ? "numeric" : undefined}
        value={value === undefined ? "" : String(value)}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          const nextValue =
            parameter.type === "integer"
              ? raw === "" || !Number.isSafeInteger(Number(raw))
                ? undefined
                : Number(raw)
              : raw;
          setParameterValue({
            blueprintKey,
            parameterKey: parameter.key,
            value: nextValue,
          });
        }}
      />
      {parameter.type === "string" && parameter.format !== "text" ? (
        <p className="text-xs text-muted-foreground">{parameter.format}</p>
      ) : null}
    </div>
  );
}

export function OfficialWorkflowConfigurationFields({
  form,
  blueprints,
  agents,
  agentsLoaded,
  showAgent,
  disabled,
}: {
  readonly form: OfficialWorkflowConfigurationForm;
  readonly blueprints: readonly OfficialWorkflowAcceptedBlueprint[];
  readonly agents: readonly ConfigurationAgent[];
  readonly agentsLoaded: boolean;
  readonly showAgent: boolean;
  readonly disabled: boolean;
}) {
  const setAgent = useSet(setOfficialWorkflowConfigurationAgent$);
  return (
    <div className="space-y-5">
      {showAgent ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">
            {i18n.t(($) => {
              return $.workflows.official.agent;
            })}
          </span>
          <Select
            value={form.agentId}
            disabled={disabled || !agentsLoaded}
            onValueChange={setAgent}
          >
            <SelectTrigger
              className="h-9 w-full"
              aria-label={i18n.t(($) => {
                return $.workflows.official.agent;
              })}
            >
              <SelectValue
                placeholder={i18n.t(($) => {
                  return $.workflows.official.selectAgent;
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => {
                return (
                  <SelectItem key={agent.agentId} value={agent.agentId}>
                    {agent.displayName ?? agent.agentId}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {blueprints.map((blueprint) => {
        return (
          <section
            key={blueprint.key}
            className="rounded-2xl border border-border bg-gray-50 p-4"
          >
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">
                {blueprint.key}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {i18n.t(
                  ($) => {
                    return $.workflows.official.parameterCount;
                  },
                  { count: blueprint.parameters.length },
                )}
              </p>
            </div>
            {blueprint.parameters.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {blueprint.parameters.map((parameter) => {
                  return (
                    <ParameterField
                      key={parameter.key}
                      blueprintKey={blueprint.key}
                      parameter={parameter}
                      value={bindingValue(form, blueprint.key, parameter.key)}
                      disabled={disabled}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {i18n.t(($) => {
                  return $.workflows.official.noParameters;
                })}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
