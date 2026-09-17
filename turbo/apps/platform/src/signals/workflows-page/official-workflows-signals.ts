import type {
  OfficialWorkflowBlueprintBindings,
  OfficialWorkflowParameterValue,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  officialWorkflowInstallationsContract,
  officialWorkflowsContract,
  type OfficialWorkflowCatalogDetail,
  type OfficialWorkflowInstallationResponse,
} from "@okouai/api-contracts/contracts/official-workflows";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { command, computed, state } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { activeRoute$ } from "../active-route.ts";
import { apiClient$ } from "../api-client.ts";
import { pathParams$ } from "../route.ts";
import { currentWorkflowId$, reloadWorkflows$ } from "./workflows-signals.ts";
import { workflowReloadVersion$ } from "./workflow-reload.ts";

const officialWorkflowReloadVersion$ = state(0);
const internalOfficialWorkflowSearch$ = state("");

export const officialWorkflowSearch$ = computed((get) => {
  return get(internalOfficialWorkflowSearch$);
});

export const setOfficialWorkflowSearch$ = command(({ set }, search: string) => {
  set(internalOfficialWorkflowSearch$, search);
});

export const reloadOfficialWorkflows$ = command(({ set }) => {
  set(officialWorkflowReloadVersion$, (version) => {
    return version + 1;
  });
});

export const officialWorkflowCatalog$ = computed(async (get) => {
  get(officialWorkflowReloadVersion$);
  get(workflowReloadVersion$);
  const client = get(apiClient$)(officialWorkflowsContract);
  const workflowsClient = get(apiClient$)(workflowsCollectionContract);
  const [catalog, workflows] = await Promise.all([
    accept(client.list(), [200]),
    accept(workflowsClient.list({ query: {} }), [200]),
  ]);
  const installedDefinitions = new Set(
    workflows.body.flatMap((workflow) => {
      return workflow.official?.installationState === "installed"
        ? [workflow.official.definitionName]
        : [];
    }),
  );
  return catalog.body.map((workflow) => {
    return {
      ...workflow,
      installed: installedDefinitions.has(workflow.name),
    };
  });
});

const currentOfficialWorkflowDefinitionName$ = computed((get) => {
  if (get(activeRoute$) !== "officialWorkflowDetail") {
    return null;
  }
  const definitionName = get(pathParams$)?.definitionName;
  return typeof definitionName === "string" ? definitionName : null;
});

export const currentOfficialWorkflowDefinition$ = computed(
  async (get): Promise<OfficialWorkflowCatalogDetail | null> => {
    get(officialWorkflowReloadVersion$);
    const definitionName = get(currentOfficialWorkflowDefinitionName$);
    if (!definitionName) {
      return null;
    }
    const client = get(apiClient$)(officialWorkflowsContract);
    const result = await accept(
      client.get({ params: { definitionName } }),
      [200, 404],
    );
    return result.status === 404 ? null : result.body;
  },
);

export const currentOfficialWorkflowInstallation$ = computed(
  async (get): Promise<OfficialWorkflowInstallationResponse | null> => {
    get(officialWorkflowReloadVersion$);
    const workflowId = get(currentWorkflowId$);
    if (!workflowId) {
      return null;
    }
    const client = get(apiClient$)(officialWorkflowInstallationsContract);
    const result = await accept(
      client.get({ params: { workflowId } }),
      [200, 404],
    );
    return result.status === 404 ? null : result.body;
  },
);

export const installOfficialWorkflow$ = command(
  async (
    { get, set },
    input: {
      readonly definitionName: string;
      readonly agentId: string;
      readonly blueprints: readonly OfficialWorkflowBlueprintBindings[];
    },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowInstallationResponse> => {
    signal.throwIfAborted();
    const client = get(apiClient$)(officialWorkflowsContract);
    const result = await accept(
      client.install({
        params: { definitionName: input.definitionName },
        body: { agentId: input.agentId, blueprints: [...input.blueprints] },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    set(reloadOfficialWorkflows$);
    return result.body;
  },
);

export const reconfigureOfficialWorkflow$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly blueprints: readonly OfficialWorkflowBlueprintBindings[];
    },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowInstallationResponse> => {
    signal.throwIfAborted();
    const client = get(apiClient$)(officialWorkflowInstallationsContract);
    const result = await accept(
      client.reconfigure({
        params: { workflowId: input.workflowId },
        body: { blueprints: [...input.blueprints] },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    set(reloadOfficialWorkflows$);
    return result.body;
  },
);

export const uninstallOfficialWorkflow$ = command(
  async ({ get, set }, workflowId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(officialWorkflowInstallationsContract);
    await accept(
      client.uninstall({ params: { workflowId }, fetchOptions: { signal } }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    set(reloadOfficialWorkflows$);
  },
);

export interface OfficialWorkflowConfigurationForm {
  readonly target:
    | { readonly operation: "install" }
    | {
        readonly operation: "reconfigure";
        readonly workflowId: string;
      };
  readonly definitionName: string;
  readonly agentId: string;
  readonly blueprints: readonly OfficialWorkflowBlueprintBindings[];
}

const internalOfficialWorkflowConfigurationForm$ =
  state<OfficialWorkflowConfigurationForm | null>(null);

export const officialWorkflowConfigurationForm$ = computed((get) => {
  return get(internalOfficialWorkflowConfigurationForm$);
});

export const setOfficialWorkflowConfigurationForm$ = command(
  ({ set }, form: OfficialWorkflowConfigurationForm | null) => {
    set(internalOfficialWorkflowConfigurationForm$, form);
  },
);

export const setOfficialWorkflowConfigurationAgent$ = command(
  ({ get, set }, agentId: string) => {
    const form = get(internalOfficialWorkflowConfigurationForm$);
    if (form) {
      set(internalOfficialWorkflowConfigurationForm$, { ...form, agentId });
    }
  },
);

export const setOfficialWorkflowParameterValue$ = command(
  (
    { get, set },
    input: {
      readonly blueprintKey: string;
      readonly parameterKey: string;
      readonly value: OfficialWorkflowParameterValue | undefined;
    },
  ) => {
    const form = get(internalOfficialWorkflowConfigurationForm$);
    if (!form) {
      return;
    }
    set(internalOfficialWorkflowConfigurationForm$, {
      ...form,
      blueprints: form.blueprints.map((blueprint) => {
        if (blueprint.blueprintKey !== input.blueprintKey) {
          return blueprint;
        }
        const retained = blueprint.bindings.filter((binding) => {
          return binding.key !== input.parameterKey;
        });
        return {
          ...blueprint,
          bindings:
            input.value === undefined
              ? retained
              : [...retained, { key: input.parameterKey, value: input.value }],
        };
      }),
    });
  },
);
