import { z } from "zod";
import type {
  SandboxChannelCategoryContract,
  SandboxChannelEvent,
  SandboxChannelOperation,
} from "./sandbox-channel";

export const SANDBOX_DIAGNOSTICS_VERSION = 1;
export const SANDBOX_DIAGNOSTICS_MAX_BYTES = 16 * 1024;
export const sandboxDiagnosticsEchoSchema = z.strictObject({
  payload: z
    .string()
    .max(4 * Math.ceil(SANDBOX_DIAGNOSTICS_MAX_BYTES / 3))
    .refine((payload) => {
      try {
        const bytes = atob(payload);
        return (
          bytes.length <= SANDBOX_DIAGNOSTICS_MAX_BYTES &&
          btoa(bytes) === payload
        );
      } catch {
        return false;
      }
    }),
});
export const sandboxDiagnosticsNoticeSchema = z.strictObject({
  message: z.string().min(1).max(256),
});
export const sandboxDiagnosticsEcho = {
  category: "diagnostics",
  categoryVersion: SANDBOX_DIAGNOSTICS_VERSION,
  operation: "echo",
  origin: "either",
  params: sandboxDiagnosticsEchoSchema,
  result: sandboxDiagnosticsEchoSchema,
} as const satisfies SandboxChannelOperation<
  z.infer<typeof sandboxDiagnosticsEchoSchema>,
  z.infer<typeof sandboxDiagnosticsEchoSchema>
>;
export const sandboxDiagnosticsPeerEcho = {
  ...sandboxDiagnosticsEcho,
  operation: "peer.echo",
  origin: "external",
} as const;
export const sandboxDiagnosticsNotice = {
  category: "diagnostics",
  categoryVersion: SANDBOX_DIAGNOSTICS_VERSION,
  event: "notice",
  origin: "either",
  data: sandboxDiagnosticsNoticeSchema,
} as const satisfies SandboxChannelEvent<
  z.infer<typeof sandboxDiagnosticsNoticeSchema>
>;
export const sandboxDiagnosticsCategory = {
  category: "diagnostics",
  version: SANDBOX_DIAGNOSTICS_VERSION,
  operations: [sandboxDiagnosticsEcho, sandboxDiagnosticsPeerEcho],
  events: [sandboxDiagnosticsNotice],
} as const satisfies SandboxChannelCategoryContract;
