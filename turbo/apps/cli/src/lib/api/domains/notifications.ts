import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  notificationsContract,
  type NotifyMailBody,
} from "@okouai/api-contracts/contracts/notifications";
import { getClientConfig, handleError } from "../core/client-factory";

export async function notifyMail(body: NotifyMailBody) {
  const client = initClient(notificationsContract, await getClientConfig());
  const result = await client.mail({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to queue email notification");
}

export async function getNotification(id: string) {
  const client = initClient(notificationsContract, await getClientConfig());
  const result = await client.get({ params: { id }, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to read notification");
}
