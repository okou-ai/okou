import { SANDBOX_CHANNEL_LIMITS } from "../contracts/sandbox-channel";
import {
  SANDBOX_FS_LIMITS,
  SANDBOX_FS_VERSION,
} from "../contracts/sandbox-channel-fs";
import {
  SANDBOX_DIAGNOSTICS_MAX_BYTES,
  SANDBOX_DIAGNOSTICS_VERSION,
} from "../contracts/sandbox-channel-diagnostics";
import type { RustConstantBinding } from "./constants";

function limits(
  module: readonly string[],
  values: Readonly<Record<string, number>>,
): RustConstantBinding[] {
  return Object.entries(values).map(([name, value]) => {
    return {
      rustModulePath: module,
      rustConstName: name
        .replace(/[A-Z]/g, (letter) => {
          return `_${letter}`;
        })
        .toUpperCase(),
      value: { kind: "u32", value },
      rustDoc: [`Shared finite policy: ${name}.`],
    };
  });
}

export const sandboxChannelConstantBindings: readonly RustConstantBinding[] = [
  ...limits(["sandbox_channel"], SANDBOX_CHANNEL_LIMITS),
  ...limits(["sandbox_channel", "fs"], {
    version: SANDBOX_FS_VERSION,
    ...SANDBOX_FS_LIMITS,
  }),
  ...limits(["sandbox_channel", "diagnostics"], {
    version: SANDBOX_DIAGNOSTICS_VERSION,
    maxBytes: SANDBOX_DIAGNOSTICS_MAX_BYTES,
  }),
];
