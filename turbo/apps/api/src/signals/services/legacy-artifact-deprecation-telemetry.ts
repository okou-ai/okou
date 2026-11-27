import { command } from "ccstate";
import {
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { settleIncludingAbort } from "../utils";

export type LegacyArtifactEndpoint =
  | "GET /api/chat-threads/:threadId/artifacts"
  | "GET /api/host/sites/:siteId/visibility"
  | "PATCH /api/host/sites/:siteId/visibility"
  | "GET /api/host/sites/:siteId/shares"
  | "GET /api/host/sites/:siteId/share-accounts"
  | "POST /api/host/sites/:siteId/shares"
  | "DELETE /api/host/sites/:siteId/shares/:shareId"
  | "GET /api/artifact-sharing/:kind/:id/shares"
  | "GET /api/artifact-sharing/:kind/:id/share-accounts"
  | "POST /api/artifact-sharing/:kind/:id/shares"
  | "DELETE /api/artifact-sharing/:kind/:id/shares/:shareId"
  | "GET /api/artifact-shares/availability"
  | "POST /api/artifact-shares/status"
  | "PUT /api/artifact-shares";

/**
 * Emit structured deprecation telemetry for legacy artifact endpoints scheduled
 * for Release 2 retirement, partitioned by `x_client_type` and `x_client_version`.
 */
export const recordLegacyArtifactEndpointCall$ = command(
  (
    { get },
    args: {
      readonly endpoint: LegacyArtifactEndpoint;
      readonly orgId?: string;
      readonly userId?: string;
    },
  ) => {
    const req = get(request$);
    const clientType = req.header(CLIENT_TYPE_HEADER) ?? "unknown";
    const clientVersion = req.header(CLIENT_VERSION_HEADER) ?? "unknown";
    waitUntil(
      settleIncludingAbort(() => {
        return ingestToAxiom(getDatasetName("web-logs"), [
          {
            _time: nowDate().toISOString(),
            type: "legacy_artifact_endpoint_called",
            source: "api",
            endpoint: args.endpoint,
            method: req.method,
            x_client_type: clientType,
            x_client_version: clientVersion,
            ...(args.orgId ? { org_id: args.orgId } : {}),
            ...(args.userId ? { user_id: args.userId } : {}),
          },
        ]);
      }),
    );
  },
);
