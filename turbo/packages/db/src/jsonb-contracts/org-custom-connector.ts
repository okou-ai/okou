export interface OrgCustomConnectorField {
  readonly key: string;
  readonly label: string;
  readonly kind: "secret" | "variable";
  readonly required: boolean;
  readonly description?: string;
}

export interface OrgCustomConnectorFirewall {
  readonly permissions: {
    readonly name: string;
    readonly description?: string;
    readonly defaultPolicy: "allow" | "deny";
    readonly rules: string[];
  }[];
}

export interface OrgCustomConnectorHeaderInjection {
  readonly name: string;
  readonly valueTemplate: string;
}

export interface OrgCustomConnectorQueryInjection {
  readonly name: string;
  readonly valueTemplate: string;
}

export type OrgCustomConnectorPrefixTemplates = string[];
export type OrgCustomConnectorFields = OrgCustomConnectorField[];
export type OrgCustomConnectorHeaderInjections =
  OrgCustomConnectorHeaderInjection[];
export type OrgCustomConnectorQueryInjections =
  OrgCustomConnectorQueryInjection[];
