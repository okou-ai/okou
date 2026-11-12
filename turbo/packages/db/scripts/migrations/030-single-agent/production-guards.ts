import { isDeepStrictEqual } from "node:util";
import { array, literal, number, object, string } from "zod";
import { PlanningError } from "./snapshot";
import {
  BRANCH,
  BUCKET,
  ENDPOINT,
  PROJECT,
  liveMembersSchema,
} from "./production-model";

async function requestJson(url: string, token: string) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "okou-single-agent-production",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new PlanningError("ProductionAuthorityRequestFailed");
  return response.json();
}

/** Resolve only the protected production branch; never use an implicit URI target. */
export async function resolveProductionTarget(token: string) {
  const base = `https://console.neon.tech/api/v2/projects/${PROJECT}`;
  object({
    branch: object({
      id: literal(BRANCH),
      default: literal(true),
      protected: literal(true),
      current_state: literal("ready"),
    }),
  }).parse(await requestJson(`${base}/branches/${BRANCH}`, token));
  const listing = object({
    endpoints: array(
      object({
        id: string().min(1),
        branch_id: string(),
        type: string(),
        host: string().min(1),
        autoscaling_limit_min_cu: number(),
        autoscaling_limit_max_cu: number(),
      }),
    ),
    pagination: object({ cursor: string().optional() }).nullish(),
  }).parse(await requestJson(`${base}/endpoints`, token));
  if (listing.pagination?.cursor)
    throw new PlanningError("IncompleteProductionEndpointListing");
  const endpoints = listing.endpoints.filter((e) => {
    return e.branch_id === BRANCH && e.type === "read_write";
  });
  if (endpoints.length !== 1)
    throw new PlanningError("ProductionEndpointNotUnique");
  const endpoint = endpoints[0]!;
  if (
    endpoint.autoscaling_limit_min_cu < 8 ||
    endpoint.autoscaling_limit_max_cu < 8
  )
    throw new PlanningError("ProductionRequiresProvisionedEightComputeUnits");
  const scope = {
    database: `${endpoint.host}:5432/neondb`,
    bucket: BUCKET,
    endpoint: ENDPOINT,
  };
  return { endpointId: endpoint.id, scope, capacity: endpoint };
}

/** A local credential must match the independently resolved target and role. */
export function validateProductionConnection(
  connection: string,
  host: string,
  writable: boolean,
) {
  const role = writable ? "neondb_owner" : "RO";
  const address = new URL(connection);
  if (
    !["postgres:", "postgresql:"].includes(address.protocol) ||
    address.hostname !== host ||
    (address.port && address.port !== "5432") ||
    address.pathname !== "/neondb" ||
    decodeURIComponent(address.username) !== role ||
    !address.password ||
    address.hash ||
    [...address.searchParams.keys()].some((key) => {
      return !["sslmode", "channel_binding"].includes(key);
    })
  )
    throw new PlanningError("ProductionConnectionIdentityRejected");
  address.searchParams.set("sslmode", "verify-full");
  return { connection: address.toString(), role };
}

/** Live Clerk is authoritative; a cached org role is not enough to admit a cutover. */
export async function verifyLiveMembers(
  orgId: string,
  expected: { userId: string; role: string }[],
  token: string,
) {
  const members: { userId: string; role: string }[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const page = object({
      total_count: number().int().nonnegative(),
      data: array(
        object({
          role: string().min(1),
          public_user_data: object({ user_id: string().min(1) }),
        }),
      ),
    }).parse(
      await requestJson(
        `https://api.clerk.com/v1/organizations/${orgId}/memberships?limit=100&offset=${offset}`,
        token,
      ),
    );
    members.push(
      ...page.data.map((row) => {
        return {
          userId: row.public_user_data.user_id,
          role: row.role,
        };
      }),
    );
    if (members.length === page.total_count) break;
    if (
      page.data.length < 100 ||
      members.length > page.total_count ||
      offset === 9900
    )
      throw new PlanningError("IncompleteLiveMembershipCensus");
  }
  const normalize = (rows: typeof members) => {
    return liveMembersSchema
      .parse(rows)
      .map((row) => {
        return {
          userId: row.userId,
          role: row.role.replace(/^org:/u, ""),
        };
      })
      .sort((a, b) => {
        return a.userId.localeCompare(b.userId);
      });
  };
  if (
    new Set(
      members.map((row) => {
        return row.userId;
      }),
    ).size !== members.length ||
    !isDeepStrictEqual(normalize(members), normalize(expected))
  )
    throw new PlanningError("LiveProductionMembershipChanged");
}
