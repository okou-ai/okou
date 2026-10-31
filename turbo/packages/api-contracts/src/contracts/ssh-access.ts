import { array, discriminatedUnion, literal, object } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sshConnectionMetadataSchema } from "./ssh-connections";
import { remoteHostIdentitySchema } from "./remote-host-identity";

export { sshChangedPayloadSchema } from "../validators/ssh-access";

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};

export const sshHostAvailabilitySchema = discriminatedUnion("status", [
  object({ status: literal("ready") }).strict(),
  object({
    status: literal("blocked"),
    reason: literal("needs_rebind"),
  }).strict(),
]);
export const sshHostSchema = sshConnectionMetadataSchema
  .pick({
    id: true,
    displayName: true,
    host: true,
    port: true,
    username: true,
    learnedHostKey: true,
  })
  .extend({ availability: sshHostAvailabilitySchema });
export const sshHostsResponseSchema = object({
  hosts: array(sshHostSchema),
  identities: array(remoteHostIdentitySchema),
}).strict();

export const sshHostsContract = c.router({
  list: {
    method: "GET",
    path: "/api/ssh/hosts",
    headers: authHeadersSchema,
    responses: { 200: sshHostsResponseSchema, ...errors },
    summary: "List current SSH hosts authorized for a running Agent",
  },
});
