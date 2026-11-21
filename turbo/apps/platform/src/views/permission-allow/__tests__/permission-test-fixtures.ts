import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorPermissionsContract,
  type ConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export const ANALYTICS = "admin.analytics:read";
export const PERMISSION_NOW = "2030-01-01T00:00:00.000Z";
export const PERMISSION_LATER = "2030-01-01T01:00:00.000Z";

type Grant = ConnectorPermissions["grants"][number];

export function mockPermissionCatalog(
  context: TestContext,
  policy: "allow" | "ask" | "deny" = "ask",
  missing?: string,
) {
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      const { connectorSlug } = params;
      if (connectorSlug === missing) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
      }
      const catalog: Record<
        string,
        { label: string; permissions: { name: string; description: string }[] }
      > = {
        slack: {
          label: "Slack",
          permissions: [
            { name: ANALYTICS, description: "Read workspace analytics" },
            { name: "chat:write", description: "Send Slack messages" },
          ],
        },
        neon: {
          label: "Neon",
          permissions: [
            { name: "branches:create", description: "Create a Neon branch" },
            { name: "branches:delete", description: "Delete a Neon branch" },
          ],
        },
        github: {
          label: "GitHub",
          permissions: [
            { name: "issues:read", description: "Read GitHub issues" },
          ],
        },
      };
      const { label, permissions } = catalog[connectorSlug]!;
      return respond(200, {
        permissions: {
          connectorSlug,
          label,
          icon: {
            url: "https://example.test/icon.svg",
            invertInDarkMode: false,
          },
          categories: null,
          permissionCount: permissions.length,
          permissions,
          defaultPolicy: { permissionDefault: policy, unknownPolicy: "ask" },
        },
      });
    },
  );
}

export function mockPermissionGrants(
  context: TestContext,
  {
    initial = [],
    acknowledge = true,
  }: {
    initial?: readonly Grant[];
    acknowledge?: boolean;
  } = {},
) {
  const saved = new Map<string, Grant[]>([["slack", [...initial]]]);
  const writes: unknown[] = [];
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, {
      target: query,
      grants:
        query.kind === "builtin" ? (saved.get(query.connectorSlug) ?? []) : [],
    });
  });
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    writes.push(body);
    const target = body.target;
    if (!acknowledge || target.kind !== "builtin") {
      return respond(200, { target, grants: [] });
    }
    const applied = body.grants.map((grant) => {
      return {
        permission: grant.permission,
        action: grant.action,
        expiresAt: grant.action === "allow" ? PERMISSION_LATER : null,
      };
    });
    const old = saved.get(target.connectorSlug) ?? [];
    const next = old.filter((grant) => {
      return !applied.some((entry) => {
        return entry.permission === grant.permission;
      });
    });
    next.push(...applied);
    saved.set(target.connectorSlug, next);
    return respond(200, { target, grants: next });
  });
  return { saved, writes };
}
