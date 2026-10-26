import type { ClientResponseTransform } from "./types";
import { computerUseSessionHostsContract } from "../contracts/computer-use";

/**
 * Response transforms for installed Desktop builds that still decode an older
 * response shape. The runtime API compatibility lint accepts a matching entry
 * as proof for a breaking change on a Desktop-consumed route; see
 * docs/deployment-compatibility.md#desktop-contract-gate.
 */
export const computerUseClaimTransforms: readonly ClientResponseTransform[] = [
  {
    client: "desktop",
    method: "POST",
    path: "/api/computer-use/hosts/:hostId/commands/next",
    status: 200,
    maxVersion: "0.53.4",
    since: "#40349",
    transform: (body) => {
      const claim =
        computerUseSessionHostsContract.next.responses[200].parse(body);
      // Pre-Shell Desktop builds advertise only GUI capabilities. Never recast
      // interactive input as a GUI command or silently discard a claimed action.
      // Retire this guard when the Desktop floor exceeds 0.53.4 (#40319).
      if (
        claim.status === "command" &&
        (claim.command.kind.startsWith("shell.") ||
          claim.command.error?.code.startsWith("shell_"))
      ) {
        throw new Error(
          "Shell claims require a Desktop build with Shell support",
        );
      }
      return claim;
    },
  },
];
