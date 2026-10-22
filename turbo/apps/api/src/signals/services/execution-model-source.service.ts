export type ModelSourceIdentity =
  | { readonly kind: "built-in"; readonly modelKeyId: string }
  | { readonly kind: "member"; readonly accountId: string };
export type ModelSourceCredential =
  EncryptedModelCredential | ManagedModelKeyReference;
export interface ManagedModelKeyReference {
  readonly kind: "managed-key";
  readonly name: string;
  readonly modelKeyId: string;
  readonly apiKey: string;
}
export interface EncryptedModelCredential {
  readonly kind: "encrypted";
  readonly name: string;
  readonly encryptedValue: string;
}
export interface ModelSourceConfiguration {
  readonly providerType: string;
  readonly authMethod: string | null;
}
export interface ModelSourceSnapshot {
  readonly identity: ModelSourceIdentity;
  readonly configuration: ModelSourceConfiguration;
  readonly credentials: readonly ModelSourceCredential[];
}
