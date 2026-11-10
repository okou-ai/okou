import { userNotificationsContract } from "@okouai/api-contracts/contracts/user-notifications";
import { mockApi } from "../msw-contract.ts";

// Staff pages have an empty inbox unless a notification scenario supplies it.
export const apiUserNotificationsHandlers = [
  mockApi(userNotificationsContract.summary, ({ respond }) => {
    return respond(200, { unreadCount: 0 });
  }),
  mockApi(userNotificationsContract.list, ({ respond }) => {
    return respond(200, { items: [], nextCursor: null });
  }),
];
