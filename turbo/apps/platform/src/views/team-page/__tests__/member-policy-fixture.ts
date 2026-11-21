import {
  connectorPermissionsContract,
  type ConnectorPermissions,
  type ApplyConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import type { PublicConnectorCatalogPermissionDetail } from "@okouai/api-contracts/contracts/connector-catalog";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockPermissionDirectory } from "./permission-editor-test-helpers.ts";

export const policyTime = "2031-03-10T12:00:00Z";
export function expiresInHours(hours: number) {
  return new Date(Date.parse(policyTime) + hours * 3_600_000).toISOString();
}
export function memberPolicies(
  context: TestContext,
  metadata: PublicConnectorCatalogPermissionDetail,
  initial: ConnectorPermissions["grants"],
) {
  mockPermissionDirectory(context, metadata);
  const saved = new Map(
    initial.map((g) => {
      return [g.permission, g];
    }),
  );
  const changes: ApplyConnectorPermissions[] = [];
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, {
      target: query,
      grants:
        query.kind === "builtin" &&
        query.connectorSlug === metadata.connectorSlug
          ? [...saved.values()]
          : [],
    });
  });
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    if (
      body.target.kind !== "builtin" ||
      body.target.connectorSlug !== metadata.connectorSlug
    ) {
      throw new Error("Unexpected permission target");
    }
    changes.push(body);
    for (const rule of body.grants) {
      const hours =
        rule.expiresIn === "1h"
          ? 1
          : rule.expiresIn === "24h"
            ? 24
            : rule.expiresIn === "7d"
              ? 168
              : 0;
      saved.set(rule.permission, {
        permission: rule.permission,
        action: rule.action,
        expiresAt: hours ? expiresInHours(hours) : null,
      });
    }
    return respond(200, { target: body.target, grants: [...saved.values()] });
  });
  return { changes, saved };
}
