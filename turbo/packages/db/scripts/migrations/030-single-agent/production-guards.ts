import { isDeepStrictEqual } from "node:util";
import { array, literal, number, object, string } from "zod";
import { PlanningError } from "./snapshot";
import {
  BRANCH,
  BUCKET,
  ENDPOINT,
  PROJECT,
  WORKFLOW,
  digestSchema,
  liveMembersSchema,
  type ProductionContext,
  type ProductionMetadata,
} from "./production-model";

export function validateProductionContext(context: ProductionContext) {
  if (context.mode === "target") return;
  if (context.mode === "plan") {
    if (
      !context.writersDrained ||
      !digestSchema.safeParse(context.prefixesSha256).success
    )
      throw new PlanningError(
        "ProductionPlanRequiresDrainedWritersAndPrefixDigest",
      );
    return;
  }
  if (
    !/^\d+$/u.test(context.planRunId) ||
    context.planRunId === context.runId ||
    !digestSchema.safeParse(context.planSha256).success ||
    !digestSchema.safeParse(context.imageSha256).success ||
    (context.mode !== "verify" && !context.writersDrained)
  )
    throw new PlanningError("ReviewedProductionImageAndWriterDrainRequired");
}

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
export async function resolveProductionTarget(
  mode: ProductionContext["mode"],
  token: string,
) {
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
  if (mode === "target")
    return { endpointId: endpoint.id, scope, capacity: endpoint };
  const role = mode === "apply" || mode === "recover" ? "neondb_owner" : "RO";
  const query = new URLSearchParams({
    branch_id: BRANCH,
    endpoint_id: endpoint.id,
    database_name: "neondb",
    role_name: role,
    pooled: "false",
  });
  const { uri } = object({ uri: string() }).parse(
    await requestJson(`${base}/connection_uri?${query}`, token),
  );
  const address = new URL(uri);
  if (
    !["postgres:", "postgresql:"].includes(address.protocol) ||
    address.hostname !== endpoint.host ||
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
  return {
    connection: address.toString(),
    endpointId: endpoint.id,
    scope,
    role,
    capacity: endpoint,
  };
}

export async function verifyProductionOrigin(
  context: ProductionContext,
  token: string,
) {
  validateProductionContext(context);
  const run = object({
    id: number().int(),
    head_sha: string().regex(/^[a-f0-9]{40}$/u),
    head_branch: string(),
    event: string(),
    status: string(),
    conclusion: string().nullable(),
    run_attempt: number().int(),
    path: string(),
    display_title: string(),
  }).parse(
    await requestJson(
      `https://api.github.com/repos/${context.repository}/actions/runs/${context.planRunId}`,
      token,
    ),
  );
  if (
    String(run.id) !== context.planRunId ||
    (context.mode === "apply" && run.head_sha !== context.driverCommit) ||
    run.head_branch !== "main" ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1 ||
    run.path !== WORKFLOW ||
    !run.display_title.startsWith(`plan single-agent ${context.orgId} `)
  )
    throw new PlanningError("ProductionPlanOriginRejected");
  if (run.head_sha !== context.driverCommit) {
    const compared = object({
      status: string(),
      merge_base_commit: object({ sha: string() }),
    }).parse(
      await requestJson(
        `https://api.github.com/repos/${context.repository}/compare/${run.head_sha}...${context.driverCommit}?per_page=1`,
        token,
      ),
    );
    if (
      !["ahead", "identical"].includes(compared.status) ||
      compared.merge_base_commit.sha !== run.head_sha
    )
      throw new PlanningError("ProductionPlanCommitNotOnMainHistory");
  }
  return {
    artifactName: `single-agent-plan-${context.planRunId}`,
    commit: run.head_sha,
  };
}

export function validateProductionMetadata(
  context: ProductionContext,
  meta: ProductionMetadata,
) {
  if (
    meta.binding.commit !== context.commit ||
    meta.binding.orgId !== context.orgId ||
    meta.binding.planRunId !== context.planRunId ||
    meta.planSha256 !== context.planSha256 ||
    meta.imageSha256 !== context.imageSha256
  )
    throw new PlanningError("ReviewedProductionMetadataMismatch");
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
