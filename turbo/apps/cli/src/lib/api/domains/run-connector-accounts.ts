import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import {
  connectorAccountTargetKey,
  type ConnectorAccountSelection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listRunConnectorAccounts() {
  const client = initClient(runConnectorAccountsContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.list({ headers: {} });
  if (result.status !== 200)
    handleError(result, "Failed to read this Run's Chat account access");
  return result.body;
}
export async function getAllowedChatConnectorTargetKeys(): Promise<
  ReadonlySet<string>
> {
  const { accounts } = await listRunConnectorAccounts();
  return new Set(
    accounts.flatMap((account) => {
      return account.enabled ? [connectorAccountTargetKey(account.target)] : [];
    }),
  );
}

export async function selectRunConnectorAccount(
  selection: ConnectorAccountSelection,
) {
  const client = initClient(runConnectorAccountsContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.select({ headers: {}, body: selection });
  if (result.status !== 200)
    handleError(result, "Failed to select an allowed Chat account");
  return result.body;
}
