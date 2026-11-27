import {
  array,
  boolean,
  discriminatedUnion,
  enum as zEnum,
  iso,
  literal,
  object,
  string,
  union,
  uuid,
  type infer as Infer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const access = discriminatedUnion("mode", [
  object({ mode: literal("denied") }),
  object({ mode: literal("always") }),
  object({ mode: literal("until"), expiresAt: iso.datetime() }),
  object({
    mode: literal("for"),
    hours: union([literal(1), literal(24), literal(168)]),
  }),
]);

const device = object({
  id: uuid(),
  displayName: string(),
  accessAllowed: boolean(),
  accessExpiresAt: iso.datetime().nullable(),
});
export const remoteDeviceChannelKindSchema = zEnum([
  "desktop",
  "ios",
  "ssh",
  "vnc",
]);
const channel = object({
  id: uuid(),
  kind: remoteDeviceChannelKindSchema,
  displayName: string(),
  lastSeenAt: iso.datetime().nullable(),
  sshDependencyIds: array(uuid()),
});
const directoryDevice = device.extend({ channels: array(channel) });
const directory = object({ devices: array(directoryDevice) });
const deviceName = string().trim().min(1).max(120);
const createDevice = object({
  id: uuid(),
  displayName: deviceName,
}).strict();
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
    responses: { ...errors, 200: directory },
  },
  listForRun: {
    method: "GET",
    path: "/api/run/remote-devices",
    headers: authHeadersSchema,
    responses: { ...errors, 200: directory.extend({ chatThreadId: uuid() }) },
  },
  create: {
    method: "POST",
    path: "/api/remote-devices",
    headers: authHeadersSchema,
    body: createDevice,
    responses: { ...errors, 200: device, 201: device },
  },
  rename: {
    method: "PATCH",
    path: "/api/remote-devices/:deviceId",
    pathParams: devicePath,
    headers: authHeadersSchema,
    body: object({ displayName: deviceName }).strict(),
    responses: { ...errors, 200: device },
  },
  moveChannel: {
    method: "PUT",
    path: "/api/remote-devices/:deviceId/channels/:kind/:channelId",
    pathParams: devicePath.extend({
      kind: remoteDeviceChannelKindSchema,
      channelId: uuid(),
    }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: { ...errors, 204: c.noBody() },
  },
  delete: {
    method: "DELETE",
    path: "/api/remote-devices/:deviceId",
    pathParams: devicePath,
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: { ...errors, 204: c.noBody(), 409: apiErrorSchema },
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

export type RemoteDevice = Infer<typeof device>;
export type RemoteDeviceChannel = Infer<typeof channel>;
export type RemoteDeviceChannelKind = Infer<
  typeof remoteDeviceChannelKindSchema
>;
export type RemoteDeviceDirectoryItem = Infer<typeof directoryDevice>;
export type RemoteDeviceAccess = Infer<typeof access>;
