import {
  deniedTailscaleConfig,
  tailscaleFailure,
  type ReferencingTailscaleHost,
  type TailscaleMetadata,
} from "./tailscale-config-model";
import {
  committedTailscaleMutation,
  planTailscaleMutation,
  type TailscaleMutationArgs,
} from "./tailscale-mutation-plan";

interface CapturedMutationRow {
  readonly config: TailscaleMetadata;
  readonly changed: TailscaleMetadata | null;
  readonly observedVersion: string;
  readonly currentVersion: string;
  readonly host: ReferencingTailscaleHost | null;
}
// Classification uses only facts decoded from the one completed statement.
export function capturedTailscaleMutation(
  args: TailscaleMutationArgs,
  rows: readonly CapturedMutationRow[],
) {
  const [first] = rows;
  if (!first) {
    return {
      retryBindings: false as const,
      value: tailscaleFailure("notFound"),
    };
  }
  if (deniedTailscaleConfig(first.config, args.owner)) {
    return {
      retryBindings: false as const,
      value: tailscaleFailure("forbidden"),
    };
  }
  const expectedRevision =
    args.operation === "promote"
      ? args.expectedRevision
      : args.body.expectedRevision;
  if (
    first.config.revision === expectedRevision &&
    first.currentVersion !== first.observedVersion
  ) {
    // Admission may have committed after the statement snapshot. Eligibility
    // gated off every write; the caller may make one fresh unwritten attempt.
    return { retryBindings: true as const };
  }
  const hosts = rows.flatMap(({ host }) => {
    return host ? [host] : [];
  });
  const planned = planTailscaleMutation(args, first.config, hosts);
  if (!planned.ok) {
    return { retryBindings: false as const, value: planned };
  }
  if (!first.changed) {
    throw new Error(
      planned.plan.kind === "delete"
        ? "Tailscale deletion returned no row"
        : planned.plan.missingRowMessage,
    );
  }
  return committedTailscaleMutation(first.changed, hosts, planned.plan);
}
