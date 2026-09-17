import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sshConnectionMetadataSchema } from "./ssh-connections";

const c = initContract();
export const sshChangedPayloadSchema = z
  .object({ orgId: z.string().min(1) })
  .strict();
const agentPath = z.object({ agentId: z.uuid() }).strict();
const accessSchema = z.object({ enabled: z.boolean() }).strict();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};

export const sshHostSchema = sshConnectionMetadataSchema.pick({
  id: true,
  displayName: true,
  host: true,
  port: true,
  username: true,
  learnedHostKey: true,
});
export const sshHostsResponseSchema = z
  .object({ hosts: z.array(sshHostSchema) })
  .strict();

export const agentSshAccessContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:agentId/ssh-access",
    pathParams: agentPath,
    headers: authHeadersSchema,
    responses: { 200: accessSchema, ...errors },
    summary: "Read the owner's Agent SSH access",
  },
  update: {
    method: "PUT",
    path: "/api/agents/:agentId/ssh-access",
    pathParams: agentPath,
    headers: authHeadersSchema,
    body: accessSchema,
    responses: { 200: accessSchema, ...errors },
    summary: "Grant or revoke access to all current owner SSH hosts",
  },
});

export const sshHostsContract = c.router({
  list: {
    method: "GET",
    path: "/api/ssh/hosts",
    headers: authHeadersSchema,
    responses: { 200: sshHostsResponseSchema, ...errors },
    summary: "List current SSH hosts authorized for a running Agent",
  },
});
