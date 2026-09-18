import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { vncConnectionResponseSchema } from "./vnc-connections";
import { vncCredentialResponseSchema } from "./vnc-credentials";

const c = initContract();
const agentPath = z.object({ agentId: z.uuid() }).strict();
const accessSchema = z.object({ enabled: z.boolean() }).strict();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};

export const vncHostSchema = vncConnectionResponseSchema
  .pick({ id: true, displayName: true, host: true, port: true })
  .extend({
    authMethod: vncCredentialResponseSchema.shape.authMethod,
    securityType: z.literal("x509_vnc"),
  });

export const agentVncAccessContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:agentId/vnc-access",
    pathParams: agentPath,
    headers: authHeadersSchema,
    responses: { 200: accessSchema, ...errors },
    summary: "Read the owner's Agent VNC access",
  },
  update: {
    method: "PUT",
    path: "/api/agents/:agentId/vnc-access",
    pathParams: agentPath,
    headers: authHeadersSchema,
    body: accessSchema,
    responses: { 200: accessSchema, ...errors },
    summary: "Explicitly grant or revoke access to current owner VNC hosts",
  },
});

export const vncHostsContract = c.router({
  list: {
    method: "GET",
    path: "/api/vnc/hosts",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ hosts: z.array(vncHostSchema) }).strict(),
      ...errors,
    },
    summary: "List current VNC hosts authorized for a running Agent",
  },
});
