import type { JsonObject } from "./shared";

export type ComputerUseSupportedCapabilities = string[];

export interface ComputerUsePermissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly automation?: {
    readonly chrome: {
      readonly status:
        "unknown" | "granted" | "denied" | "not_installed" | "not_running";
      readonly updatedAt: string | null;
      readonly reason: string | null;
    };
    readonly safari: {
      readonly status:
        "unknown" | "granted" | "denied" | "not_installed" | "not_running";
      readonly updatedAt: string | null;
      readonly reason: string | null;
    };
  };
}

export type ComputerUseCommandPayload = JsonObject;
export type ComputerUseCommandResult = JsonObject;
export type ComputerUseCommandAuditRedactedResult = JsonObject;
export type ComputerUseCommandAuditError = JsonObject;
