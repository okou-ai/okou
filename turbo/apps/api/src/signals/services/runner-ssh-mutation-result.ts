import {
  sshHostKeySchema,
  type RunnerSshPinRequest,
  type RunnerSshPinResponse,
} from "@okouai/api-contracts/contracts/runner-ssh";

interface Authority {
  readonly generation: number;
  readonly algorithm: string | null;
  readonly fingerprint: string | null;
  readonly transport: string;
  readonly needsRebind: boolean;
  readonly accessId: string | null;
  readonly tailscaleId: string | null;
  readonly accessConfigId: string | null;
  readonly tailscaleConfigId: string | null;
}
export function availableRunnerMutationAuthority(
  row:
    | { readonly current: Authority | null; readonly eligibleId: string | null }
    | undefined,
) {
  const current = row?.current;
  if (!current || current.needsRebind) {
    return null;
  }
  if (
    current.transport === "tailscale" &&
    (current.tailscaleId === null || current.tailscaleConfigId === null)
  ) {
    throw new Error("SSH Tailscale configuration is missing");
  }
  if (
    current.transport === "cloudflare_access" &&
    (current.accessId === null || current.accessConfigId === null)
  ) {
    throw new Error("SSH Cloudflare Access is missing");
  }
  return row?.eligibleId === null ? null : current;
}
export function runnerPinDecision(
  row: Authority,
  input: RunnerSshPinRequest,
): RunnerSshPinResponse | null {
  if (row.algorithm !== null || row.fingerprint !== null) {
    const existing = sshHostKeySchema.parse({
      algorithm: row.algorithm,
      fingerprint: row.fingerprint,
    });
    if (
      existing.algorithm !== input.observedHostKey.algorithm ||
      existing.fingerprint !== input.observedHostKey.fingerprint
    ) {
      return { outcome: "host_key_mismatch" };
    }
    return row.generation === input.expectedGeneration + 1
      ? { outcome: "matched", generation: row.generation }
      : { outcome: "configuration_changed" };
  }
  return row.generation !== input.expectedGeneration ||
    row.generation === 2_147_483_647
    ? { outcome: "configuration_changed" }
    : null;
}
