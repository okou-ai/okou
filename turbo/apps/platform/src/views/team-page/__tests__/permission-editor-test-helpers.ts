import {
  connectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorPermissionsContract,
  type ApplyConnectorPermissions,
  type ConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  mockPublicConnectorStatus,
} from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import {
  catalogConnectorFixture,
  mockConnectorOverview,
} from "./team-page-test-helpers.ts";

export type SavedPermissionGrant = ConnectorPermissions["grants"][number];

/**
 * Serves one connected built-in connector with its permission metadata and
 * the member's saved connector-wide rules. Returns every applied rule change.
 */
export function mockConnectorPermissionRules(
  context: TestContext,
  metadata: PublicConnectorCatalogPermissionDetail,
  grants: readonly SavedPermissionGrant[],
): ApplyConnectorPermissions[] {
  const connector = catalogConnectorFixture(
    metadata.connectorSlug,
    metadata.label,
    { permissionCount: metadata.permissionCount },
  );
  mockPublicConnectorStatus(context, [connector]);
  mockConnectorOverview(context, [connector]);
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      return params.connectorSlug === metadata.connectorSlug
        ? respond(200, { permissions: metadata })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Connector not found" },
          });
    },
  );
  const applied: ApplyConnectorPermissions[] = [];
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, { target: query, grants: [...grants] });
  });
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    applied.push(body);
    return respond(200, { target: body.target, grants: [...grants] });
  });
  return applied;
}

/** Opens the connector's Permissions dialog from its Connectors page card. */
export async function openConnectorPermissions(
  context: TestContext,
  label: string,
): Promise<HTMLElement> {
  await setupPage({ context, path: "/connectors?scope=connected" });
  const permissions = await waitFor(() => {
    const action = getConnectorAction(
      "button",
      "Permissions",
      getConnectorCard(label),
    );
    expect(action).toBeEnabled();
    return action;
  });
  click(permissions);
  const dialog = await screen.findByRole("dialog", {
    name: `${label} permissions`,
  });
  await within(dialog).findByRole("textbox", { name: "Find permissions" });
  return dialog;
}

export function permissionRow(
  dialog: HTMLElement,
  permission: string,
): HTMLElement {
  const row = queryPermissionRow(dialog, permission);
  if (!row) {
    throw new Error(`Expected permission row "${permission}"`);
  }
  return row;
}

export function queryPermissionRow(
  dialog: HTMLElement,
  permission: string,
): HTMLElement | null {
  return within(dialog).queryByRole("group", { name: permission });
}

/** The Allow or Deny half of a permission, group or Other endpoints toggle. */
export function policyButton(
  container: HTMLElement,
  policy: "Allow" | "Deny",
): HTMLElement {
  return getConnectorAction("button", policy, container);
}

export function allowDuration(
  container: HTMLElement,
  permission: string,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === `${permission} allow options`
      );
    }) ?? null
  );
}

export async function chooseAllowDuration(
  container: HTMLElement,
  permission: string,
  option: "Allow for 1h" | "Allow for 24h" | "Allow for 7d" | "Allow always",
): Promise<void> {
  const trigger = allowDuration(container, permission);
  if (!trigger) {
    throw new Error(`Expected ${permission} allow options`);
  }
  click(trigger);
  click(
    await waitFor(() => {
      const item = queryAllByRoleFast("menuitemradio").find((candidate) => {
        return candidate.textContent?.trim() === option;
      });
      if (!item) {
        throw new Error(`Expected the ${option} duration`);
      }
      return item;
    }),
  );
}

/** Expands a permission category from its header. */
export function expandPermissionGroup(
  dialog: HTMLElement,
  category: string,
  count: number,
): void {
  click(getConnectorAction("button", `${category} (${count})`, dialog));
}

export function otherEndpoints(dialog: HTMLElement): HTMLElement {
  const section =
    within(dialog).getByText("Other endpoints").parentElement?.parentElement;
  if (!section) {
    throw new Error("Expected the Other endpoints policy");
  }
  return section;
}

export function dialogAction(
  dialog: HTMLElement,
  name: "Apply" | "Cancel" | "Restore",
): HTMLElement {
  return getConnectorAction("button", name, dialog);
}
