import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  VNC_DISPLAY_NAME_MAX_LENGTH,
  vncCredentialSelectionSchema,
} from "./vnc-credentials";

export const VNC_HOST_MAX_LENGTH = 253;
export const VNC_CA_BUNDLE_MAX_LENGTH = 65_536;
export const VNC_CA_CERTIFICATES_MAX_COUNT = 8;

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(VNC_DISPLAY_NAME_MAX_LENGTH);
const hostSchema = z.string().trim().min(1).max(VNC_HOST_MAX_LENGTH);
const portSchema = z.int().min(1).max(65_535);
const generationSchema = z.int().positive().max(2_147_483_647);
const directTransportSchema = z.object({ type: z.literal("direct") }).strict();
const sshTransportSchema = z
  .object({ type: z.literal("ssh"), connectionId: z.uuid() })
  .strict();
export const vncTransportSchema = z.discriminatedUnion("type", [
  directTransportSchema,
  sshTransportSchema,
]);

export const vncTrustSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("system") }).strict(),
  z
    .object({
      mode: z.literal("custom_ca"),
      caBundle: z.string().min(1).max(VNC_CA_BUNDLE_MAX_LENGTH),
    })
    .strict(),
]);

const vncX509VncSecurityVariantSchema = z
  .object({
    type: z.literal("x509_vnc"),
    trust: vncTrustSchema,
    serverName: hostSchema.optional(),
  })
  .strict();
const vncX509PlainSecurityVariantSchema = z
  .object({
    type: z.literal("x509_plain"),
    trust: vncTrustSchema,
    serverName: hostSchema.optional(),
  })
  .strict();
// Keep current-only Runner schemas as one-variant discriminated unions so the
// Rust generator preserves the existing enum-shaped wire type.
export const vncX509VncSecuritySchema = z.discriminatedUnion("type", [
  vncX509VncSecurityVariantSchema,
]);
export const vncX509PlainSecuritySchema = z.discriminatedUnion("type", [
  vncX509PlainSecurityVariantSchema,
]);
export const vncSecuritySchema = z.discriminatedUnion("type", [
  vncX509VncSecurityVariantSchema,
  vncX509PlainSecurityVariantSchema,
]);

export const createVncConnectionRequestSchema = z
  .object({
    id: z.uuid(),
    displayName: displayNameSchema,
    host: hostSchema,
    port: portSchema.default(5900),
    credential: vncCredentialSelectionSchema,
    security: vncSecuritySchema,
    transport: vncTransportSchema.optional(),
  })
  .strict();

export const updateVncConnectionRequestSchema = z
  .object({
    expectedGeneration: generationSchema,
    displayName: displayNameSchema.optional(),
    host: hostSchema.optional(),
    port: portSchema.optional(),
    credential: vncCredentialSelectionSchema.optional(),
    security: vncSecuritySchema.optional(),
    transport: vncTransportSchema.optional(),
  })
  .strict()
  .refine(
    (body) => {
      return (
        body.displayName !== undefined ||
        body.host !== undefined ||
        body.port !== undefined ||
        body.credential !== undefined ||
        body.security !== undefined ||
        body.transport !== undefined
      );
    },
    { message: "At least one VNC connection field must be updated" },
  );

export const vncConnectionPathParamsSchema = z
  .object({ connectionId: z.uuid() })
  .strict();

export const vncConnectionMetadataSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    host: z.string(),
    port: portSchema,
    credentialId: z.uuid(),
    credentialName: z.string(),
    security: vncSecuritySchema,
    generation: generationSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const vncConnectionResponseSchema = z.union([
  vncConnectionMetadataSchema,
  vncConnectionMetadataSchema.extend({ transport: sshTransportSchema }),
]);

export const vncConnectionsListResponseSchema = z
  .object({ connections: z.array(vncConnectionResponseSchema) })
  .strict();
export const vncConnectionsSummaryResponseSchema = z
  .object({ configuredCount: z.int().nonnegative() })
  .strict();

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
};

export const vncConnectionsContract = c.router({
  list: {
    method: "GET",
    path: "/api/vnc/connections",
    headers: authHeadersSchema,
    responses: { 200: vncConnectionsListResponseSchema, ...errors },
    summary: "List owned VNC connections",
  },
  summary: {
    method: "GET",
    path: "/api/vnc/connections/summary",
    headers: authHeadersSchema,
    responses: { 200: vncConnectionsSummaryResponseSchema, ...errors },
    summary: "Summarize owned VNC connection configuration",
  },
  create: {
    method: "POST",
    path: "/api/vnc/connections",
    headers: authHeadersSchema,
    body: createVncConnectionRequestSchema,
    responses: { 201: vncConnectionResponseSchema, 204: c.noBody(), ...errors },
    summary: "Create a VNC connection",
  },
  update: {
    method: "PATCH",
    path: "/api/vnc/connections/:connectionId",
    headers: authHeadersSchema,
    pathParams: vncConnectionPathParamsSchema,
    body: updateVncConnectionRequestSchema,
    responses: { 200: vncConnectionResponseSchema, ...errors },
    summary: "Update an owned VNC connection",
  },
  delete: {
    method: "DELETE",
    path: "/api/vnc/connections/:connectionId",
    headers: authHeadersSchema,
    pathParams: vncConnectionPathParamsSchema,
    body: z.object({ expectedGeneration: generationSchema }).strict(),
    responses: { 204: c.noBody(), ...errors },
    summary: "Delete an owned VNC connection",
  },
});

export type CreateVncConnectionRequest = z.infer<
  typeof createVncConnectionRequestSchema
>;
export type UpdateVncConnectionRequest = z.infer<
  typeof updateVncConnectionRequestSchema
>;
export type VncConnectionResponse = z.infer<typeof vncConnectionResponseSchema>;
export type VncTrust = z.infer<typeof vncTrustSchema>;
export type VncSecurity = z.infer<typeof vncSecuritySchema>;
export type VncTransport = z.infer<typeof vncTransportSchema>;
