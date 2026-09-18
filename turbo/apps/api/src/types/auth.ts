import type { Capability } from "@okouai/api-contracts/contracts/capabilities";

export type ApiOrgRole = "admin" | "member";

type SessionAuthContext =
  | {
      readonly tokenType: "session";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: ApiOrgRole;
    }
  | {
      readonly tokenType: "session";
      readonly userId: string;
      readonly orgId?: undefined;
      readonly orgRole?: undefined;
    };

type PatAuthContext =
  | {
      readonly tokenType: "pat";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: ApiOrgRole;
    }
  | {
      readonly tokenType: "pat";
      readonly userId: string;
      readonly orgId?: undefined;
      readonly orgRole?: undefined;
    };

interface SandboxAuthContext {
  readonly tokenType: "sandbox";
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: undefined;
  readonly runId: string;
}

export type AgentAuthContext =
  | {
      readonly tokenType: "agent";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole?: ApiOrgRole;
      readonly runId: string;
      readonly capabilities: readonly Capability[];
      readonly computerUseHostId?: string;
      readonly customConnectorSourceIds?: Readonly<Record<string, string>>;
      readonly builtinConnectorSourceIds?: Readonly<Record<string, string>>;
    }
  | {
      readonly tokenType: "agent";
      readonly userId: string;
      readonly runId: string;
      readonly orgId?: undefined;
      readonly orgRole?: undefined;
      readonly capabilities?: undefined;
    };

export type AuthContext =
  | {
      readonly tokenType: "oauth";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: ApiOrgRole;
    }
  | SessionAuthContext
  | PatAuthContext
  | SandboxAuthContext
  | AgentAuthContext;

export type AuthTokenType = AuthContext["tokenType"];

export interface CliTokenRecord {
  readonly userId: string;
  readonly orgId: string;
}

export interface SandboxAuth {
  readonly piSandbox?: {
    readonly ownerEpoch: number;
    readonly generation: number;
  };
  readonly userId: string;
  readonly runId: string;
  readonly orgId: string;
}

export interface AgentAuth {
  readonly userId: string;
  readonly runId: string;
  readonly orgId: string;
  readonly capabilities: readonly Capability[];
  readonly computerUseHostId?: string;
  readonly cloudBrowserEnabled?: true;
  readonly customConnectorSourceIds?: Readonly<Record<string, string>>;
  readonly builtinConnectorSourceIds?: Readonly<Record<string, string>>;
}

export interface CliAuth {
  readonly userId: string;
  readonly orgId: string;
  readonly tokenId: string;
}

export interface ComposeJobAuth {
  readonly userId: string;
  readonly jobId: string;
}
