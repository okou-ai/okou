import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import type { ConnectorCheckPolicy } from "@okouai/api-contracts/contracts/connector-check";
import { diagnoseConnectorCheck } from "../../lib/api/domains/connectors";
import { getPlatformOrigin } from "../../lib/platform-url";
import {
  buildConnectorUrlDiagnosticRequest,
  resolveConnectorCheckDiagnostic,
  type CheckConnectorOptions,
  type ResolvedDiagnostic,
} from "./check-diagnostic";
import {
  customConnectorIdFromSelector,
  customConnectorSettingsGuidance,
} from "./custom-connector-guidance";
import { resolveDiagnosticConnectorSelector } from "./diagnostic-connector-selector";

function permissionMismatchError(args: {
  readonly permission: string;
  readonly method: string;
  readonly url: string;
  readonly matchedPermissions: readonly string[];
}): Error {
  return new Error(
    `Permission "${args.permission}" does not match ${args.method} ${args.url}. The request maps to: ${args.matchedPermissions.join(", ")}. Use the exact permission-request command printed by okou connector check; provider OAuth scopes and missing_scope/needed values cannot be granted here.`,
  );
}

function permissionPolicyForDiagnostic(args: {
  readonly result: ResolvedDiagnostic;
  readonly permission: string;
  readonly method: string;
  readonly url: string;
}): ConnectorCheckPolicy {
  if (args.result.mode !== "url") {
    throw new Error(
      "Connector diagnostic returned an environment result for a URL request.",
    );
  }
  const permission = args.result.permission;
  if (permission.kind === "unknown-endpoint") {
    if (args.permission === UNKNOWN_PERMISSION_GRANT) return permission.policy;
  } else {
    const matched = permission.permissions.find((item) => {
      return item.name === args.permission;
    });
    if (args.permission !== UNKNOWN_PERMISSION_GRANT && matched !== undefined)
      return matched.policy;
  }
  throw permissionMismatchError({
    ...args,
    matchedPermissions:
      permission.kind === "unknown-endpoint"
        ? [UNKNOWN_PERMISSION_GRANT]
        : permission.permissions.map((item) => {
            return item.name;
          }),
  });
}

/** Resolve and validate a real URL diagnostic before either approval flow emits output. */
export async function diagnosePermissionRequest(
  selector: string,
  permission: string,
  options: CheckConnectorOptions,
) {
  const connectorSlug = await resolveDiagnosticConnectorSelector(selector);
  const customId = customConnectorIdFromSelector(connectorSlug);
  if (customId !== undefined) {
    throw new Error(
      customConnectorSettingsGuidance(
        customId,
        await getPlatformOrigin(),
        permission,
      ),
    );
  }
  if (options.url === undefined) {
    throw new Error(
      "--url is required for connector permission requests. Run okou connector check --url <FAILED_URL> --method <METHOD> and use the permission-request command it prints.",
    );
  }
  const request = buildConnectorUrlDiagnosticRequest({
    ...options,
    url: options.url,
    connector: connectorSlug,
  });
  const diagnostic = await diagnoseConnectorCheck(request);
  const result = resolveConnectorCheckDiagnostic(request, diagnostic);
  if (result.connector.target.kind !== "builtin") {
    throw new Error(
      "Builtin permission requests require a builtin diagnostic target.",
    );
  }
  const policy = permissionPolicyForDiagnostic({
    result,
    permission,
    method: request.method,
    url: request.url,
  });
  if (policy.outcome === "unavailable") {
    throw new Error(
      `Okou permission policy is unavailable for ${request.method} ${request.url}. Retry okou connector check from an active run before requesting access.`,
    );
  }
  return {
    connectorSlug: result.connector.target.connectorSlug,
    label: result.connector.label,
    policy,
    request,
  };
}

export function printAwsPermissionDiagnosticGuidance(): void {
  console.log(
    "AWS selectors describe the intended operation only; no SigV4 signature was validated and no AWS request was sent.",
  );
}
