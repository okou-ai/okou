export type PiMemoryPhase2CredentialFailure =
  | "source_credentials_missing"
  | "credential_unavailable"
  | "provider_model_unsupported"
  | "model_route_unavailable"
  | "pi_memory_disabled"
  | "storage_binding_changed";

export class PiMemoryPhase2CredentialError extends Error {
  constructor(readonly errorClass: PiMemoryPhase2CredentialFailure) {
    super("Pi memory Phase 2 credential admission failed");
    this.name = "PiMemoryPhase2CredentialError";
  }
}

export interface PiMemoryCredentialSource {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
  readonly id: string | null;
  readonly scope: "org" | "member";
}
export interface PiMemoryAccountSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly externalAccountId: string;
  readonly authMethod: string | null;
}
export interface PiMemoryKeySnapshot {
  readonly id: string;
  readonly secretId: string;
  readonly encryptedValue: string;
}
export interface PiMemorySurfaceSnapshot extends PiMemoryKeySnapshot {
  readonly protocol: string;
  readonly baseUrl: string;
  readonly header: string;
  readonly template: string;
  readonly mappings: Record<string, string>;
  readonly connectionId: string;
}
export interface PiMemoryQuotaPairRow {
  readonly id: string;
  readonly name: string;
  readonly encryptedValue: string;
}
export type PiMemoryCredentialSnapshot =
  | "built-in"
  | PiMemoryAccountSnapshot
  | PiMemoryKeySnapshot
  | PiMemorySurfaceSnapshot;
export type PiMemoryCredentialProof =
  | { readonly kind: "built-in"; readonly source: PiMemoryCredentialSource }
  | {
      readonly kind: "subscription";
      readonly source: PiMemoryCredentialSource & { readonly id: string };
      readonly snapshot: PiMemoryAccountSnapshot;
      readonly quotaPair: readonly PiMemoryQuotaPairRow[];
    }
  | {
      readonly kind: "api-key";
      readonly source: PiMemoryCredentialSource & { readonly id: string };
      readonly snapshot: PiMemoryKeySnapshot;
      readonly credentialSecretName: string;
    }
  | {
      readonly kind: "custom";
      readonly source: PiMemoryCredentialSource & { readonly id: string };
      readonly snapshot: PiMemorySurfaceSnapshot;
    };

export interface PiMemoryPhase2ProducerBinding {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
  readonly selectionDigest: string;
  readonly credential: PiMemoryCredentialProof;
}

/** Private, non-persisted producer facts. Never an executor or signal bundle. */
export interface RunProducerBinding {
  readonly phase2?: PiMemoryPhase2ProducerBinding;
  readonly requestStage1: boolean;
}
