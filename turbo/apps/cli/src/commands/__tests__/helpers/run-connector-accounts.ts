import { writeFileSync } from "node:fs";

import {
  connectorAccountsContract,
  connectorAccountTargetKey,
  type ConnectorAccountInspectionResult,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import { http, HttpResponse } from "msw";
import type { infer as zInfer } from "zod";

type RunConnectorAccountContextTarget = ConnectorAccountTarget & {
  readonly connectionId: string | null;
};

type AvailableConnectorAccount = Extract<
  ConnectorAccountInspectionResult,
  { readonly kind: "available" }
>;

function accountKey(
  target: ConnectorAccountTarget,
  connectionId: string,
): string {
  return `${connectorAccountTargetKey(target)}:${connectionId}`;
}

export function writeRunConnectorAccountContext(
  path: string,
  targets: readonly RunConnectorAccountContextTarget[],
): void {
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, targets }), "utf8");
}

export function stubRunConnectorAccountInspection(
  accounts: readonly AvailableConnectorAccount[],
  origin = "http://localhost:3000",
) {
  const accountsByKey = new Map(
    accounts.map((account) => {
      return [
        accountKey(account.target, account.connectionId),
        account,
      ] as const;
    }),
  );
  return http.post(
    `${origin}/api/connector-accounts/inspect`,
    async ({ request }) => {
      const body = connectorAccountsContract.inspect.body.parse(
        await request.json(),
      );
      return HttpResponse.json({
        results: body.selections.map((selection) => {
          return (
            accountsByKey.get(
              accountKey(selection.target, selection.connectionId),
            ) ?? { kind: "unavailable" as const, ...selection }
          );
        }),
      });
    },
  );
}

type RunConnectorAccountInventory = zInfer<
  (typeof runConnectorAccountsContract.list.responses)[200]
>;

export function stubRunConnectorAccountInventory(
  inventory: Partial<RunConnectorAccountInventory>,
  origin = "http://localhost:3000",
  onRequest?: () => void,
) {
  return http.get(`${origin}/api/run/connector-accounts`, () => {
    onRequest?.();
    return HttpResponse.json({
      chatThreadId: "22222222-2222-4222-8222-222222222222",
      accounts: [],
      permissionGrants: [],
      ...inventory,
    });
  });
}
