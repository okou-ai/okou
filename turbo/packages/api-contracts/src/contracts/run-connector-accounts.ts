import { array, boolean, enum as zEnum, object, string, uuid } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  connectorAccountSelectionSchema,
  connectorAccountTargetSchema,
} from "./connector-accounts";
import { apiErrorSchema } from "./errors";

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
} as const;
export const runConnectorAccountsContract = c.router({
  list: {
    method: "GET",
    path: "/api/run/connector-accounts",
    headers: authHeadersSchema,
    responses: {
      200: object({
        chatThreadId: uuid(),
        accounts: array(
          object({
            target: connectorAccountTargetSchema,
            connectionId: uuid(),
            displayName: string().nullable(),
            enabled: boolean(),
            isCurrent: boolean(),
            isDefault: boolean(),
          }).strict(),
        ),
        permissionGrants: array(
          object({
            target: connectorAccountTargetSchema,
            permission: string(),
            action: zEnum(["allow", "deny"]),
            expiresAt: string().nullable(),
          }).strict(),
        ),
      }).strict(),
      ...errors,
    },
    summary:
      "Read safe account allowance and current selection for the authenticated Run",
  },
  select: {
    method: "PUT",
    path: "/api/run/connector-accounts/current",
    headers: authHeadersSchema,
    body: connectorAccountSelectionSchema,
    responses: { 200: connectorAccountSelectionSchema, ...errors },
    summary: "Select an already allowed account for this Run's Chat",
  },
  approve: {
    method: "POST",
    path: "/api/chat-threads/:threadId/connector-account-approval",
    headers: authHeadersSchema,
    pathParams: object({ threadId: uuid() }),
    body: connectorAccountSelectionSchema,
    responses: { 200: connectorAccountSelectionSchema, ...errors },
    summary:
      "Owner confirmation allowing and selecting one exact account in a Chat",
  },
});
