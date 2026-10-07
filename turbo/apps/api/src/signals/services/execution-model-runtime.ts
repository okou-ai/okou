import {
  getSecretsForAuthMethod,
  MODEL_PROVIDER_TYPES,
} from "@okouai/api-contracts/contracts/model-providers";
import { AUTO_RUN_PROVIDER } from "@okouai/core/auto-run-model";
import type { ModelSourceSnapshot } from "./execution-model-source.service";
export type ModelCredentialValues = Readonly<Record<string, string>>;
export type ModelRuntimeSelection =
  | {
      readonly kind: "built-in";
      readonly selectedModel: string;
      readonly providerType: string;
      readonly upstreamModel: string;
      readonly modelKeyId: string;
    }
  | {
      readonly kind: "subscription";
      readonly selectedModel: string;
      readonly upstreamModel: string;
    };
export interface ModelRuntimeInput {
  readonly selection: ModelRuntimeSelection;
  readonly source: ModelSourceSnapshot;
  readonly credentials: ModelCredentialValues;
}
export interface CompiledModelRuntime {
  readonly selectedModel: string;
  readonly upstreamModel: string;
  readonly providerType: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

/** Every model provider is firewall-injected: env carries secret references. */
function secretReference(secretName: string): string {
  return `\${{ secrets.${secretName} }}`;
}

function compileCodexSubscriptionRuntime(
  input: ModelRuntimeInput,
): CompiledModelRuntime {
  const { source, selection, credentials } = input;
  if (selection.kind !== "subscription") {
    throw new Error("Multi-auth runtime requires a selected subscription");
  }
  const type = "codex-oauth-token";
  const authMethod = source.configuration.authMethod;
  const required = authMethod
    ? getSecretsForAuthMethod(type, authMethod)
    : undefined;
  if (!required) {
    throw new Error("Multi-auth authentication method is unavailable");
  }
  const forwardable: Record<string, string> = {};
  for (const [name, rule] of Object.entries(required)) {
    const value = credentials[name];
    if (!value) {
      if (rule.required) {
        throw new Error(`Account credential ${name} is missing`);
      }
      continue;
    }
    if (!rule.serverOnly) {
      forwardable[name] = value;
    }
  }
  const accountId = credentials.CHATGPT_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("Codex account routing identity is missing");
  }
  return {
    selectedModel: selection.selectedModel,
    upstreamModel: selection.upstreamModel,
    providerType: type,
    environment: {
      CHATGPT_ACCESS_TOKEN: secretReference("CHATGPT_ACCESS_TOKEN"),
      CHATGPT_ACCOUNT_ID: secretReference("CHATGPT_ACCOUNT_ID"),
      OPENAI_MODEL: selection.upstreamModel,
      CODEX_OAUTH_ACCOUNT_ID: accountId,
    },
    secrets: forwardable,
  };
}

function compileClaudeSubscriptionRuntime(
  input: ModelRuntimeInput,
): CompiledModelRuntime {
  const { selection, credentials } = input;
  if (selection.kind !== "subscription") {
    throw new Error("Subscription source requires a subscription selection");
  }
  const type = "claude-code-oauth-token";
  const secretName = MODEL_PROVIDER_TYPES[type].secretName;
  const key = credentials[secretName];
  if (!key?.trim()) {
    throw new Error(`Model credential ${secretName} is missing`);
  }
  return {
    selectedModel: selection.selectedModel,
    upstreamModel: selection.upstreamModel,
    providerType: type,
    environment: {
      CLAUDE_CODE_OAUTH_TOKEN: secretReference(secretName),
      ANTHROPIC_MODEL: selection.upstreamModel,
    },
    secrets: { [secretName]: key },
  };
}

function compileManagedRuntime(input: ModelRuntimeInput): CompiledModelRuntime {
  const { source, selection, credentials } = input;
  if (
    selection.kind !== "built-in" ||
    source.identity.kind !== "built-in" ||
    source.identity.modelKeyId !== selection.modelKeyId
  ) {
    throw new Error("Managed model source and route identity mismatch");
  }
  // The managed source loader admits only the Auto key vendor.
  if (selection.providerType !== AUTO_RUN_PROVIDER) {
    throw new Error(
      "Managed model vendor does not match its selected provider",
    );
  }
  const secretName = MODEL_PROVIDER_TYPES[AUTO_RUN_PROVIDER].secretName;
  if (
    !source.credentials.some((credential) => {
      return (
        credential.kind === "managed-key" &&
        credential.modelKeyId === selection.modelKeyId &&
        credential.name === secretName
      );
    })
  ) {
    throw new Error(
      "Managed model credential reference does not match its selected route",
    );
  }
  const key = credentials[secretName];
  if (!key?.trim()) {
    throw new Error("Managed model credential is missing");
  }
  return {
    selectedModel: selection.selectedModel,
    upstreamModel: selection.upstreamModel,
    providerType: AUTO_RUN_PROVIDER,
    environment: {
      OPENAI_API_KEY: secretReference(secretName),
      OPENAI_BASE_URL:
        MODEL_PROVIDER_TYPES[AUTO_RUN_PROVIDER].envBindings.OPENAI_BASE_URL,
      OPENAI_MODEL: selection.upstreamModel,
    },
    secrets: { [secretName]: key },
  };
}

/** Pure selected-route conversion. It neither reads nor decrypts a source. */
export function compileModelRuntime(
  input: ModelRuntimeInput,
): CompiledModelRuntime {
  const { source, selection } = input;
  if (!selection.selectedModel || !selection.upstreamModel) {
    throw new Error(
      "Model runtime requires its selected logical and upstream facts",
    );
  }
  if (selection.kind === "built-in") {
    return compileManagedRuntime(input);
  }
  if (source.identity.kind === "member") {
    if (source.configuration.providerType === "codex-oauth-token") {
      return compileCodexSubscriptionRuntime(input);
    }
    if (source.configuration.providerType === "claude-code-oauth-token") {
      return compileClaudeSubscriptionRuntime(input);
    }
  }
  throw new Error(
    "Subscription runtime requires a personal subscription account",
  );
}
