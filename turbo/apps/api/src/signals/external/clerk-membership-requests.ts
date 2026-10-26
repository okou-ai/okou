import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { z } from "zod";

import { env } from "../../lib/env";
import { settle, startUntrackedBestEffortCleanup } from "../utils";
import {
  ClerkRateLimitError,
  createClerkReadContext,
  retryClerkRead,
  type ClerkReadContext,
} from "./clerk";

const CLERK_API_BASE = "https://api.clerk.com/v1";

const membershipRequestDataSchema = z.object({
  id: z.string(),
  public_user_data: z.object({ user_id: z.string().min(1) }),
  created_at: z.number(),
});

const clerkMembershipRequestsResponseSchema = z.object({
  data: z.array(membershipRequestDataSchema),
});

type ClerkMembershipRequestData = z.infer<typeof membershipRequestDataSchema>;

function cancelUnusedResponseBody(response: Response): void {
  if (response.body) {
    startUntrackedBestEffortCleanup(response.body.cancel());
  }
}

/**
 * Fetch pending membership requests for an organization.
 *
 * Clerk's backend SDK does not expose a typed method for this endpoint, so we
 * call the REST API directly and validate the response shape with zod.
 *
 * Returns [] when Clerk responds 404 (the membership_requests feature is not
 * enabled for the org). Throws on any other non-OK response.
 */
async function requestClerkMembershipRequests(
  orgId: string,
  signal: AbortSignal,
): Promise<readonly ClerkMembershipRequestData[]> {
  const secretKey = env("CLERK_SECRET_KEY");
  const result = await settle(
    accept(
      fetch(
        `${CLERK_API_BASE}/organizations/${orgId}/membership_requests?status=pending`,
        {
          headers: { Authorization: `Bearer ${secretKey}` },
          signal,
        },
      ),
      [200, 404, 429],
    ),
    signal,
  );
  if (!result.ok) {
    if (result.error instanceof HttpStatusError) {
      cancelUnusedResponseBody(result.error.response);
    }
    throw result.error;
  }
  const res = result.value;
  if (res.status === 404) {
    cancelUnusedResponseBody(res);
    return [];
  }
  if (res.status === 429) {
    cancelUnusedResponseBody(res);
    throw new ClerkRateLimitError(
      `Failed to fetch membership requests for org ${orgId}: HTTP 429`,
      Number(res.headers.get("Retry-After")),
    );
  }
  const body = clerkMembershipRequestsResponseSchema.parse(await res.json());
  return body.data;
}

export async function fetchClerkMembershipRequests(
  orgId: string,
  context: ClerkReadContext = createClerkReadContext(),
  signal: AbortSignal = new AbortController().signal,
): Promise<readonly ClerkMembershipRequestData[]> {
  return await retryClerkRead(
    () => {
      return requestClerkMembershipRequests(orgId, signal);
    },
    context,
    signal,
  );
}

export async function acceptClerkMembershipRequest(args: {
  readonly orgId: string;
  readonly requestId: string;
}): Promise<{ readonly ok: boolean }> {
  const secretKey = env("CLERK_SECRET_KEY");
  const responseResult = await settle(
    accept(
      fetch(
        `${CLERK_API_BASE}/organizations/${args.orgId}/membership_requests/${args.requestId}/accept`,
        { method: "POST", headers: { Authorization: `Bearer ${secretKey}` } },
      ),
      [200, 201, 204],
    ),
  );
  if (!responseResult.ok) {
    const error = responseResult.error;
    if (!(error instanceof HttpStatusError)) {
      throw error;
    }
    cancelUnusedResponseBody(error.response);
    return { ok: false };
  }
  const res = responseResult.value;
  cancelUnusedResponseBody(res);
  return { ok: true };
}

export async function rejectClerkMembershipRequest(args: {
  readonly orgId: string;
  readonly requestId: string;
}): Promise<{ readonly ok: boolean }> {
  const secretKey = env("CLERK_SECRET_KEY");
  const responseResult = await settle(
    accept(
      fetch(
        `${CLERK_API_BASE}/organizations/${args.orgId}/membership_requests/${args.requestId}/reject`,
        { method: "POST", headers: { Authorization: `Bearer ${secretKey}` } },
      ),
      [200, 201, 204],
    ),
  );
  if (!responseResult.ok) {
    const error = responseResult.error;
    if (!(error instanceof HttpStatusError)) {
      throw error;
    }
    cancelUnusedResponseBody(error.response);
    return { ok: false };
  }
  const res = responseResult.value;
  cancelUnusedResponseBody(res);
  return { ok: true };
}
