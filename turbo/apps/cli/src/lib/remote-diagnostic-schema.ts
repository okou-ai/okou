import { z } from "zod";

const nativeFailure = z.enum([
  "resource_exhausted",
  "cancelled",
  "domain_failed",
  "cleanup_timed_out",
]);
const sshFailure = z.enum([
  "unavailable",
  "authority_failure",
  "invalid_credential",
  "unsupported_credential",
  "credential_resource_limit",
  "unsafe_destination",
  "network_failure",
  "host_key_mismatch",
  "unsupported_host_key",
  "configuration_changed",
  "authentication_failed",
  "protocol",
  "exec_rejected",
  "disconnected",
  "timed_out",
  "cancelled",
  "resource_exhausted",
  "transport",
]);
const vncFailure = z.enum([
  "unavailable",
  "authority_failure",
  "configuration_changed",
  "unsupported_profile",
  "invalid_credential",
  "unsafe_destination",
  "network_failure",
  "protocol",
  "timed_out",
  "cancelled",
  "resource_exhausted",
  "session_not_found",
  "invalid_input",
  "stale_geometry",
  "disconnected",
  "authentication_failed",
  "delivery_unknown",
  "kerberos_expired",
  "kerberos_non_renewable",
  "kerberos_renewal_exhausted",
]);
const cause = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("ssh"), code: sshFailure }),
  z.strictObject({ source: z.literal("vnc"), code: vncFailure }),
  z.strictObject({ source: z.literal("native"), code: nativeFailure }),
]);
const protocolSchema = z.enum(["ssh", "vnc"]);
export type Protocol = z.infer<typeof protocolSchema>;
const generation = z.number().int().min(1).max(0x7fffffff);
const reportSchema = z.strictObject({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  assignment_id: z.uuid(),
  attempt_id: z.uuid(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  observed_at: z.iso.datetime(),
  protocol: protocolSchema,
  connection_id: z.uuid(),
  session_id: z.uuid().nullable(),
  configuration_created_at: z.iso.datetime().nullable(),
  configuration_generation: generation.nullable(),
  operation: z.enum([
    "exec",
    "session",
    "file",
    "forwarding",
    "start",
    "capture",
    "input",
    "retirement",
    "native",
  ]),
  stage: z.enum(["ssh_operation", "vnc_operation", "native_runtime"]),
  cause,
  dependencies: z
    .array(
      z.strictObject({
        protocol: z.literal("ssh"),
        connection_id: z.uuid(),
        cause: cause.nullable(),
        configuration_created_at: z.iso.datetime().nullable(),
        configuration_generation: generation.nullable(),
      }),
    )
    .max(1),
  native: z
    .strictObject({
      configuration_id: z.uuid(),
      generation,
      resource_id: z.uuid(),
      evidence: z.strictObject({
        ready: z.boolean(),
        terminal: nativeFailure.nullable(),
        cleanup_complete: z.boolean(),
        cleanup_failure: nativeFailure.nullable(),
      }),
    })
    .nullable(),
  detail: z.literal("not_observed"),
  truncated: z.boolean(),
});
export const querySchema = z.strictObject({
  schema_version: z.literal(1),
  status: z.enum([
    "found",
    "no_failure",
    "not_retained",
    "authority_unavailable",
    "unavailable",
  ]),
  report: reportSchema.nullable(),
  retention: z.strictObject({
    capacity: z.literal(64),
    evicted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    latest_failure_pinned: z.literal(true),
  }),
});
export const capabilitiesSchema = z.strictObject({
  schema_version: z.literal(1),
  passive_query: z.boolean(),
  active_check: z.boolean(),
});
export const rpcErrorSchema = z.strictObject({
  type: z.literal("error"),
  code: z.enum([
    "invalid_request",
    "unknown_method",
    "unavailable",
    "protocol",
    "transport",
    "timed_out",
    "resource_exhausted",
  ]),
  delivery: z.enum(["not_dispatched", "unknown"]),
});

const fileCause = z.strictObject({
  source: z.literal("file"),
  code: z.enum([
    "invalid_path",
    "file_too_large",
    "transfer_limit",
    "path_not_found",
    "permission_denied",
    "destination_exists",
    "not_regular_file",
    "source_changed",
    "subsystem_unavailable",
    "unsupported_operation",
    "file_operation_failed",
  ]),
});
const nextActionSchema = z.enum([
  "check_access_certificate",
  "check_access_policy",
  "check_access_websocket",
  "check_access_route",
  "verify_host_key",
  "check_credential",
  "check_authority",
  "check_capacity",
  "check_destination_policy",
  "check_transfer_limits",
  "check_remote_file",
  "inspect_native_source",
  "check_dns",
  "check_route_and_port",
  "inspect_operation_without_replay",
]);
const reportV2Schema = reportSchema.extend({
  detail: z.enum(["partial", "not_observed"]),
  schema_version: z.literal(2),
  cause: z.union([cause, fileCause]),
  next_action: nextActionSchema,
  ssh: z
    .strictObject({
      access_failure: z
        .enum(["tls", "protocol", "rejected", "network"])
        .nullable(),
      route: z.enum(["unknown", "direct", "cloudflare_access", "tailscale"]),
      transport: z.enum(["unknown", "fresh", "reused"]),
      selected_address: z.union([z.ipv4(), z.ipv6()]).nullable(),
      address_family: z.enum(["ipv4", "ipv6"]).nullable(),
      stages: z
        .array(
          z.strictObject({
            stage: z.enum([
              "authority",
              "credential",
              "dns",
              "destination_policy",
              "tcp",
              "access_tls",
              "access_websocket",
              "ssh_proof",
              "ssh_trust",
              "authentication",
              "operation",
              "forwarding",
            ]),
            status: z.enum([
              "not_reached",
              "passed",
              "failed",
              "unknown",
              "reused",
            ]),
          }),
        )
        .max(32),
    })
    .nullable(),
});
export const queryV2Schema = querySchema.extend({
  schema_version: z.literal(2),
  report: reportV2Schema.nullable(),
});
const diagnosticMethods = [
  "ssh.exec.diagnostics.v2",
  "ssh.file.upload.diagnostics.v2",
  "ssh.file.download.diagnostics.v2",
  "ssh.session.start.diagnostics.v2",
  "ssh.session.status.diagnostics.v2",
  "ssh.session.read.diagnostics.v2",
  "ssh.session.write.diagnostics.v2",
  "ssh.session.signal.diagnostics.v2",
  "ssh.session.close.diagnostics.v2",
] as const;
export const sshCapabilitiesSchema = z.strictObject({
  schema_version: z.literal(2),
  passive_query: z.boolean(),
  automatic_methods: z.array(z.enum(diagnosticMethods)).max(9),
  query_method: z.literal("ssh.diagnostics.query.v2"),
});
export type ReportV2 = z.infer<typeof reportV2Schema>;
export const attachmentSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("found"), report: reportV2Schema }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["not_recorded", "disabled"]),
  }),
]);
