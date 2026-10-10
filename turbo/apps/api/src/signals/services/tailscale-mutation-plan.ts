import type {
  ConvertTailscaleRequest,
  DeleteTailscaleRequest,
  UpdateTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import type { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import {
  changesTagMembership,
  exhaustedTailscaleConfig,
  tailscaleFailure,
  tailscaleImpactSnapshot,
  type TailscaleConfigArgs,
  type TailscaleMetadata,
  type ReferencingTailscaleHost,
} from "./tailscale-config-model";

export type TailscaleEncryptedCredentials = Pick<
  typeof tailscaleConfigs.$inferSelect,
  "encryptedClientId" | "encryptedClientSecret"
>;
export type TailscaleMutationArgs = TailscaleConfigArgs &
  (
    | {
        readonly operation: "update";
        readonly body: UpdateTailscaleRequest;
        readonly encrypted: TailscaleEncryptedCredentials | undefined;
      }
    | { readonly operation: "delete"; readonly body: DeleteTailscaleRequest }
    | { readonly operation: "promote"; readonly expectedRevision: number }
    | { readonly operation: "adopt"; readonly body: ConvertTailscaleRequest }
  );
interface MutationEffects {
  readonly scope: TailscaleMetadata["scope"];
  readonly hosts: ReferencingTailscaleHost[];
}
type MutationPlan = MutationEffects &
  (
    | { readonly kind: "delete" }
    | {
        readonly kind: "write";
        readonly missingRowMessage: string;
      }
  );
type PlannedMutation =
  | { readonly ok: true; readonly plan: MutationPlan }
  | ReturnType<typeof tailscaleFailure>;

function planUpdate(
  args: Extract<TailscaleMutationArgs, { operation: "update" }>,
  config: TailscaleMetadata,
  hosts: ReferencingTailscaleHost[],
): PlannedMutation {
  if (config.revision !== args.body.expectedRevision) {
    return tailscaleFailure("conflict");
  }
  const effective =
    args.encrypted !== undefined ||
    changesTagMembership(args.body.tags, config.tags);
  if (exhaustedTailscaleConfig(config, hosts, effective)) {
    return tailscaleFailure("exhausted");
  }
  return {
    ok: true,
    plan: {
      kind: "write",
      missingRowMessage: "Tailscale update returned no row",
      scope: config.scope,
      hosts: effective ? hosts : [],
    },
  };
}
function planDelete(
  args: Extract<TailscaleMutationArgs, { operation: "delete" }>,
  config: TailscaleMetadata,
  hosts: ReferencingTailscaleHost[],
): PlannedMutation {
  if (config.revision !== args.body.expectedRevision) {
    return tailscaleFailure("conflict");
  }
  if (
    hosts.some((host) => {
      return host.userId === args.owner.userId;
    })
  ) {
    return tailscaleFailure("inUse");
  }
  if (
    (args.body.impactSnapshot !== undefined &&
      args.body.impactSnapshot !== tailscaleImpactSnapshot(config, hosts)) ||
    (hosts.length > 0 &&
      (config.scope !== "organization" ||
        args.body.impactSnapshot === undefined))
  ) {
    return tailscaleFailure("impactConflict");
  }
  if (
    hosts.some((host) => {
      return host.generation === 2_147_483_647;
    })
  ) {
    return tailscaleFailure("exhausted");
  }
  return {
    ok: true,
    plan: {
      kind: "delete",
      scope: config.scope,
      hosts: [],
    },
  };
}
function planPromotion(
  args: Extract<TailscaleMutationArgs, { operation: "promote" }>,
  config: TailscaleMetadata,
  hosts: ReferencingTailscaleHost[],
): PlannedMutation {
  if (config.scope !== "personal") {
    return tailscaleFailure("notFound");
  }
  if (config.revision !== args.expectedRevision) {
    return tailscaleFailure("conflict");
  }
  if (exhaustedTailscaleConfig(config, hosts)) {
    return tailscaleFailure("exhausted");
  }
  if (
    hosts.some((host) => {
      return host.userId !== args.owner.userId;
    })
  ) {
    return tailscaleFailure("inUse");
  }
  return {
    ok: true,
    plan: {
      kind: "write",
      missingRowMessage: "Tailscale promotion returned no row",
      scope: "organization",
      hosts,
    },
  };
}
function planAdoption(
  args: Extract<TailscaleMutationArgs, { operation: "adopt" }>,
  config: TailscaleMetadata,
  hosts: ReferencingTailscaleHost[],
): PlannedMutation {
  if (config.scope !== "organization") {
    return tailscaleFailure("notFound");
  }
  if (config.revision !== args.body.expectedRevision) {
    return tailscaleFailure("conflict");
  }
  if (tailscaleImpactSnapshot(config, hosts) !== args.body.impactSnapshot) {
    return tailscaleFailure("impactConflict");
  }
  if (exhaustedTailscaleConfig(config, hosts)) {
    return tailscaleFailure("exhausted");
  }
  return {
    ok: true,
    plan: {
      kind: "write",
      missingRowMessage: "Tailscale conversion returned no row",
      scope: "organization",
      hosts,
    },
  };
}
export function committedTailscaleMutation(
  config: TailscaleMetadata,
  hosts: ReferencingTailscaleHost[],
  plan: MutationPlan,
) {
  return {
    retryBindings: false as const,
    value: {
      ok: true as const,
      config,
      hosts,
      invalidatedHosts: plan.hosts,
      scope: plan.scope,
    },
  };
}

// Pure rejection and post-commit notice decisions from captured facts only.
// SQL owns eligibility and atomic writes; no obsolete write plan is replayed.
export function planTailscaleMutation(
  args: TailscaleMutationArgs,
  config: TailscaleMetadata,
  hosts: ReferencingTailscaleHost[],
): PlannedMutation {
  switch (args.operation) {
    case "update": {
      return planUpdate(args, config, hosts);
    }
    case "delete": {
      return planDelete(args, config, hosts);
    }
    case "promote": {
      return planPromotion(args, config, hosts);
    }
    case "adopt": {
      return planAdoption(args, config, hosts);
    }
  }
}
