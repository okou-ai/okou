import {
  array,
  boolean,
  discriminatedUnion,
  iso,
  literal,
  object,
  string,
  uuid,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const access = discriminatedUnion("mode", [
  object({ mode: literal("denied") }),
  object({ mode: literal("always") }),
  object({ mode: literal("until"), expiresAt: iso.datetime() }),
]);

const device = object({
  id: uuid(),
  displayName: string(),
  accessAllowed: boolean(),
  accessExpiresAt: iso.datetime().nullable(),
});
const devicePath = object({ deviceId: uuid() });
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
};
const c = initContract();

export const remoteDevicesContract = c.router({
  list: {
    method: "GET",
    path: "/api/remote-devices",
    headers: authHeadersSchema,
    responses: { ...errors, 200: object({ devices: array(device) }) },
  },
  setAccess: {
    method: "PUT",
    path: "/api/remote-devices/:deviceId/access",
    pathParams: devicePath,
    headers: authHeadersSchema,
    body: access,
    responses: { ...errors, 200: device },
  },
  approve: {
    method: "POST",
    path: "/api/chat-threads/:threadId/remote-device-approval",
    pathParams: object({ threadId: uuid() }),
    headers: authHeadersSchema,
    body: devicePath,
    responses: { ...errors, 200: device },
  },
});
