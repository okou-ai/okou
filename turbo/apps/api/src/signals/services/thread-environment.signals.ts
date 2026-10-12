import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import { FirewallBaseUrlResolutionError } from "@okouai/connectors/firewall-types";
import { expandVariables } from "@okouai/core/variable-expander";
import { computed, type Computed } from "ccstate";
import { env } from "../../lib/env";
import { badRequestMessage } from "../../lib/error";
import { VERCEL_AUTOMATION_BYPASS_ENV } from "../../lib/preview-automation-bypass";
import { previewAutomationBypass$ } from "../context/hono";
import { safeSync } from "../utils";
import { compactRecord } from "./connector-runtime-preparation.service";
import { modelProviderPermissionManifest } from "./permission-manifest.service";
import {
  emptyEnvironment,
  type Environment,
  mergeEnvironments,
} from "./run-environment";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { createConnectorEnvironmentSignals } from "./thread-connector-environment.signals";
import type { ThreadContext } from "./thread-context.signals";
import type { ThreadModelError } from "./thread-model.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

type EnvironmentError = ThreadModelError | ReturnType<typeof badRequestMessage>;

function isEnvironmentError(value: unknown): value is EnvironmentError {
  return typeof value === "object" && value !== null && "status" in value;
}

/** The selected model provider's environment, secrets and firewall. */
export function createModelProviderEnvironmentSignals(
  bootstrap: AgentRunContextSignals,
  threadContext: ThreadContext,
) {
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [modelProvider, body] = await Promise.all([
      get(threadContext.modelRoute$),
      get(bootstrap.bodyEnvironment$),
    ]);
    if (isEnvironmentError(modelProvider)) {
      return modelProvider;
    }
    if (!modelProvider) {
      return emptyEnvironment();
    }
    const manifestResult = safeSync(() => {
      return modelProviderPermissionManifest(modelProvider, body.vars);
    });
    if ("error" in manifestResult) {
      if (manifestResult.error instanceof FirewallBaseUrlResolutionError) {
        return badRequestMessage(manifestResult.error.message);
      }
      throw manifestResult.error;
    }
    const manifest = manifestResult.ok;
    return {
      vars: undefined,
      environment: compactRecord(
        expandVariables(modelProvider.environment, {
          vars: body.vars,
          secrets: {
            ...modelProvider.secrets,
            ...manifest?.environmentSecretPlaceholders,
          },
        }).result,
      ),
      platformEnvironment: undefined,
      secrets: compactRecord(modelProvider.secrets),
      secretConnectorMap: modelProvider.secretConnectorMap,
      secretConnectorMetadataMap: modelProvider.secretConnectorMetadataMap,
      firewalls: manifest?.firewalls ?? [],
      networkPolicies: manifest?.networkPolicies ?? {},
      environmentSecretPlaceholders: manifest?.environmentSecretPlaceholders,
      billableFirewalls: manifest?.billableFirewalls ?? [],
      runtimeTargets: [],
      reservedSecretAliases: [],
    };
  });
}

/** The integration a picked event arrived from, as the sandbox sees it. */
function currentIntegration(
  contextType: PickedThreadInputEvent["contextType"],
  feishuPlatform: string | undefined,
): string | undefined {
  switch (contextType) {
    case "web":
    case "agent_run": {
      return "web";
    }
    case "feishu": {
      return feishuPlatform;
    }
    case "agentphone": {
      return "phone";
    }
    case "slack":
    case "teams":
    case "telegram":
    case "discord": {
      return contextType;
    }
    default: {
      return undefined;
    }
  }
}

/**
 * Trusted platform entries describing this run to the sandbox: app URL, Agent,
 * thread, integration, model options and the preview automation bypass.
 */
export function createPlatformEnvironmentSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [event, selection] = await Promise.all([
      get(pickedEvent$),
      get(threadContext.subscriptionSelection$),
    ]);
    if (!event) {
      throw new Error("Platform environment requires a picked event");
    }
    if (isEnvironmentError(selection)) {
      return selection;
    }
    const integration = currentIntegration(
      event.contextType,
      event.contextType === "feishu"
        ? (await get(threadContext.feishuContext$))?.platform
        : undefined,
    );
    const previewAutomationBypass = get(previewAutomationBypass$);
    return {
      ...emptyEnvironment(),
      platformEnvironment: {
        OKOU_APP_URL: env("APP_URL"),
        OKOU_AGENT_ID: bootstrap.agentId,
        ...(integration ? { OKOU_CURRENT_INTEGRATION: integration } : {}),
        ...(selection.reasoningEffort
          ? { OKOU_REASONING_EFFORT: selection.reasoningEffort }
          : {}),
        // The in-sandbox CLI binds a newly created automation to this thread.
        OKOU_CHAT_THREAD_ID: event.chatThreadId,
        ...(selection.codexServiceTier
          ? { OKOU_CODEX_SERVICE_TIER: selection.codexServiceTier }
          : {}),
        ...(previewAutomationBypass
          ? { [VERCEL_AUTOMATION_BYPASS_ENV]: previewAutomationBypass }
          : {}),
      },
    };
  });
}

/**
 * Paid-tool switches: the tools the user disabled, and whether a framework's
 * native web search replaces Okou web search. That needs Claude Code or Codex
 * outside Pi, billed to the user's own key or subscription.
 */
export function createPaidToolEnvironmentSignals(
  bootstrap: AgentRunContextSignals,
  threadContext: ThreadContext,
) {
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [disabledTools, framework, modelProvider, selection] =
      await Promise.all([
        get(bootstrap.disabledPaidTools$),
        get(threadContext.providerFramework$),
        get(threadContext.modelRoute$),
        get(threadContext.subscriptionSelection$),
      ]);
    if (isEnvironmentError(framework)) {
      return framework;
    }
    if (isEnvironmentError(modelProvider)) {
      return modelProvider;
    }
    if (isEnvironmentError(selection)) {
      return selection;
    }
    const frameworkWebSearch =
      !selection.piExecution &&
      disabledTools.includes("web-search") &&
      (framework === "claude-code" || framework === "codex") &&
      (modelProvider === null ||
        !isBuiltInModelProviderType(modelProvider.type));
    return {
      ...emptyEnvironment(),
      platformEnvironment: {
        [DISABLED_PAID_TOOLS_ENV_VAR]: JSON.stringify(disabledTools),
        ...(frameworkWebSearch
          ? { [ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR]: "true" }
          : {}),
      },
    };
  });
}

/**
 * The Run environment before its Okou token: connector and model-provider
 * sources merged in one place. Model-provider secrets and environment entries
 * override connector ones; its firewall is matched first.
 */
export function createEnvironmentSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  const connectorEnvironment$ = createConnectorEnvironmentSignals(
    bootstrap,
    threadContext,
  );
  const modelProviderEnvironment$ = createModelProviderEnvironmentSignals(
    bootstrap,
    threadContext,
  );
  const paidToolEnvironment$ = createPaidToolEnvironmentSignals(
    bootstrap,
    threadContext,
  );
  const platformEnvironment$ = createPlatformEnvironmentSignals(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [connector, modelProvider, paidTools, platform] = await Promise.all([
      get(connectorEnvironment$),
      get(modelProviderEnvironment$),
      get(paidToolEnvironment$),
      get(platformEnvironment$),
    ]);
    if (isEnvironmentError(paidTools)) {
      return paidTools;
    }
    if (isEnvironmentError(platform)) {
      return platform;
    }
    if (isEnvironmentError(connector)) {
      return connector;
    }
    if (isEnvironmentError(modelProvider)) {
      return modelProvider;
    }
    return mergeEnvironments(
      [connector, modelProvider, platform, paidTools],
      [modelProvider, connector, platform, paidTools],
    );
  });
}
