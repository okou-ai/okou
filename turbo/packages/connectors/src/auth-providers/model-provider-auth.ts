import type {
  ModelProviderAuthProviderRefreshResult,
  ModelProviderRefreshTokenAuthProvider,
} from "./types";
import type { ProviderEnv } from "./provider-env";
import { codexOauthProvider } from "./model-providers/codex-oauth/provider";
import {
  getChatgptRefreshSecretName,
  getChatgptSecretName,
} from "./model-providers/codex-oauth/oauth";

export const MODEL_PROVIDER_REFRESH_PROVIDER_KEYS = [
  "codex-oauth-token",
] as const;

export type ModelProviderRefreshProviderKey =
  (typeof MODEL_PROVIDER_REFRESH_PROVIDER_KEYS)[number];

export interface ModelProviderRefreshMetadata {
  readonly isRefreshable: true;
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly refreshableSecrets: readonly string[];
}

const MODEL_PROVIDER_REFRESH_METADATA = {
  "codex-oauth-token": {
    isRefreshable: true,
    inputs: {
      refreshToken: getChatgptRefreshSecretName(),
    },
    outputs: {
      accessToken: getChatgptSecretName(),
      refreshToken: getChatgptRefreshSecretName(),
    },
    refreshableSecrets: [getChatgptSecretName()],
  },
} as const satisfies Record<
  ModelProviderRefreshProviderKey,
  ModelProviderRefreshMetadata
>;

type ModelProviderRefreshMetadataMap = typeof MODEL_PROVIDER_REFRESH_METADATA;

type ModelProviderRefreshInputValues<
  ProviderKey extends ModelProviderRefreshProviderKey,
> = {
  readonly [
    InputName in keyof ModelProviderRefreshMetadataMap[ProviderKey]["inputs"]
  ]: string;
};

type ModelProviderRefreshableSecretName<
  ProviderKey extends ModelProviderRefreshProviderKey,
> = ModelProviderRefreshMetadataMap[ProviderKey] extends {
  readonly refreshableSecrets: readonly (infer SecretName)[];
}
  ? Extract<SecretName, string>
  : never;

type ModelProviderRequiredRefreshOutputName<
  ProviderKey extends ModelProviderRefreshProviderKey,
> = {
  readonly [
    OutputName in keyof ModelProviderRefreshMetadataMap[ProviderKey]["outputs"]
  ]: ModelProviderRefreshMetadataMap[ProviderKey]["outputs"][OutputName] extends ModelProviderRefreshableSecretName<ProviderKey>
    ? OutputName
    : never;
}[keyof ModelProviderRefreshMetadataMap[ProviderKey]["outputs"]];

type ModelProviderRefreshOutputValues<
  ProviderKey extends ModelProviderRefreshProviderKey,
> = Readonly<
  Record<
    Extract<ModelProviderRequiredRefreshOutputName<ProviderKey>, string>,
    string
  >
> & {
  readonly [
    OutputName in Exclude<
      keyof ModelProviderRefreshMetadataMap[ProviderKey]["outputs"],
      ModelProviderRequiredRefreshOutputName<ProviderKey>
    >
  ]?: string;
};

type ModelProviderRefreshProviderMap = {
  readonly [
    Key in ModelProviderRefreshProviderKey
  ]: ModelProviderRefreshTokenAuthProvider<
    ModelProviderRefreshInputValues<Key>,
    ModelProviderRefreshOutputValues<Key>
  >;
};

const MODEL_PROVIDER_REFRESH_PROVIDERS: ModelProviderRefreshProviderMap = {
  "codex-oauth-token": codexOauthProvider,
};

export function isModelProviderRefreshProviderKey(
  providerKey: string,
): providerKey is ModelProviderRefreshProviderKey {
  return Object.hasOwn(MODEL_PROVIDER_REFRESH_PROVIDERS, providerKey);
}

export function getModelProviderRefreshMetadata(
  providerKey: ModelProviderRefreshProviderKey,
): ModelProviderRefreshMetadata;
export function getModelProviderRefreshMetadata(
  providerKey: string,
): ModelProviderRefreshMetadata | undefined;
export function getModelProviderRefreshMetadata(
  providerKey: string,
): ModelProviderRefreshMetadata | undefined {
  if (!isModelProviderRefreshProviderKey(providerKey)) {
    return undefined;
  }

  return MODEL_PROVIDER_REFRESH_METADATA[providerKey];
}

export function isModelProviderRefreshConfigured(args: {
  readonly providerKey: ModelProviderRefreshProviderKey;
  readonly currentEnv: ProviderEnv;
}): boolean {
  const access = MODEL_PROVIDER_REFRESH_PROVIDERS[args.providerKey].access;
  return Boolean(access.resolveAuthClient(args.currentEnv));
}

export async function refreshModelProviderAccess<
  ProviderKey extends ModelProviderRefreshProviderKey,
>(
  args: {
    readonly providerKey: ProviderKey;
    readonly currentEnv: ProviderEnv;
    readonly inputs: ModelProviderRefreshInputValues<ProviderKey>;
  },
  signal: AbortSignal,
): Promise<
  ModelProviderAuthProviderRefreshResult<
    ModelProviderRefreshOutputValues<ProviderKey>
  >
> {
  const access = MODEL_PROVIDER_REFRESH_PROVIDERS[args.providerKey].access;
  const authClient = access.resolveAuthClient(args.currentEnv);
  if (!authClient) {
    throw new Error(`${args.providerKey} auth client not configured`);
  }

  return await access.refresh(
    {
      authClient,
      inputs: args.inputs,
    },
    signal,
  );
}

export async function refreshPreparedModelProviderAccess(
  args: {
    readonly providerKey: ModelProviderRefreshProviderKey;
    readonly currentEnv: ProviderEnv;
    readonly inputs: Readonly<Record<string, string>>;
  },
  signal: AbortSignal,
): Promise<
  ModelProviderAuthProviderRefreshResult<
    Readonly<Record<string, string | undefined>>
  >
> {
  switch (args.providerKey) {
    case "codex-oauth-token": {
      return await refreshModelProviderAccess(
        {
          providerKey: args.providerKey,
          currentEnv: args.currentEnv,
          inputs: {
            refreshToken: requiredModelProviderRefreshInput({
              providerKey: args.providerKey,
              inputs: args.inputs,
              inputName: "refreshToken",
            }),
          },
        },
        signal,
      );
    }
  }
}

function requiredModelProviderRefreshInput(args: {
  readonly providerKey: ModelProviderRefreshProviderKey;
  readonly inputs: Readonly<Record<string, string>>;
  readonly inputName: string;
}): string {
  const value = args.inputs[args.inputName];
  if (value === undefined) {
    throw new Error(
      `${args.providerKey} refresh input ${args.inputName} missing after refresh state validation`,
    );
  }
  return value;
}
