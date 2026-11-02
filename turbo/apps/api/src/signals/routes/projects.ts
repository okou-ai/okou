import { command, computed } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { chatThreadSnapshotProjectionSchema } from "@okouai/api-contracts/validators/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  projectList,
  projectById,
  projectEventsAfter,
  mutateProject$,
  setProjectMembership$,
} from "../services/project.service";
import {
  publishProjectSnapshot$,
  projectCursorExpired,
} from "../services/project-snapshot.service";
import { chatThreadOrganizationPredicate } from "../services/chat-thread-organization.service";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

export const projectAccess$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  return isFeatureEnabled(
    FeatureSwitchKey.Projects,
    await get(userFeatureSwitchContext(auth.orgId, auth.userId)),
  );
});
const unavailable = notFound("Project not found");
const conflict = Object.freeze({
  status: 409 as const,
  body: {
    error: {
      code: "CONFLICT",
      message:
        "Project operation is expired or its identity has already been used",
    },
  },
});
const list$ = computed(async (get) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  return {
    status: 200 as const,
    body: { projects: await get(projectList(get(organizationAuthContext$))) },
  };
});
const read$ = computed(async (get) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  const project = await get(
    projectById(
      get(organizationAuthContext$),
      get(pathParamsOf(projectsContract.get)).id,
    ),
  );
  return project ? { status: 200 as const, body: project } : unavailable;
});
const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  const body = await get(bodyResultOf(projectsContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const owner = get(organizationAuthContext$);
  const result = await set(
    mutateProject$,
    owner,
    { kind: "created", ...body.data },
    signal,
  );
  if (result !== "written") {
    return result === "conflict" ? conflict : unavailable;
  }
  const project = await get(projectById(owner, body.data.id));
  signal.throwIfAborted();
  if (!project) {
    return unavailable;
  }
  await publishThreadListChanged(owner);
  signal.throwIfAborted();
  return { status: 201 as const, body: project };
});
const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  const body = await get(bodyResultOf(projectsContract.update));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const owner = get(organizationAuthContext$);
  const id = get(pathParamsOf(projectsContract.update)).id;
  const result = await set(
    mutateProject$,
    owner,
    { kind: "renamed", id, ...body.data },
    signal,
  );
  if (result !== "written") {
    return result === "conflict" ? conflict : unavailable;
  }
  const project = await get(projectById(owner, id));
  signal.throwIfAborted();
  if (!project) {
    return unavailable;
  }
  await publishThreadListChanged(owner);
  signal.throwIfAborted();
  return { status: 200 as const, body: project };
});
const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  const body = await get(bodyResultOf(projectsContract.delete));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const owner = get(organizationAuthContext$);
  const result = await set(
    mutateProject$,
    owner,
    {
      kind: "deleted",
      id: get(pathParamsOf(projectsContract.delete)).id,
      eventId: body.data.eventId,
    },
    signal,
  );
  if (result !== "written") {
    return result === "conflict" ? conflict : unavailable;
  }
  await publishThreadListChanged(owner);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});
const membership$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  const body = await get(bodyResultOf(projectsContract.membership));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const owner = get(organizationAuthContext$);
  const threadId = get(pathParamsOf(projectsContract.membership)).id;
  const result = await set(
    setProjectMembership$,
    owner,
    { threadId, ...body.data },
    signal,
  );
  if (result !== "written") {
    return result === "conflict" ? conflict : unavailable;
  }
  await publishThreadListChanged(owner);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { threadId, projectId: body.data.projectId },
  };
});
const threads$ = computed(async (get) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  const owner = get(organizationAuthContext$);
  const id = get(pathParamsOf(projectsContract.threads)).id;
  if (!(await get(projectById(owner, id)))) {
    return unavailable;
  }
  const q = get(queryOf(projectsContract.threads));
  const rows = await get(db$)
    .select()
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, owner.userId),
        eq(chatThreads.projectId, id),
        eq(chatThreads.hidden, false),
        chatThreadOrganizationPredicate(owner.orgId),
        q.after ? gt(chatThreads.id, q.after) : undefined,
        q.agentId ? eq(chatThreads.agentId, q.agentId) : undefined,
        q.archived === "all"
          ? undefined
          : eq(chatThreads.archived, q.archived === "true"),
      ),
    )
    .orderBy(asc(chatThreads.id))
    .limit(q.limit + 1);
  const threads = rows.slice(0, q.limit).map((t) => {
    return chatThreadSnapshotProjectionSchema.parse({
      ...t,
      sortAt: t.lastMessageAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      pinnedAt: t.pinnedAt?.toISOString() ?? null,
      renamedAt: t.renamedAt?.toISOString() ?? null,
      serviceTier: t.codexServiceTier === "fast" ? "priority" : null,
    });
  });
  return {
    status: 200 as const,
    body: {
      threads,
      nextAfter: rows.length > q.limit ? threads.at(-1)!.id : null,
    },
  };
});
const snapshot$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  return {
    status: 200 as const,
    body: await set(
      publishProjectSnapshot$,
      get(organizationAuthContext$),
      signal,
    ),
  };
});
const events$ = computed(async (get) => {
  if (!(await get(projectAccess$))) {
    return unavailable;
  }
  const owner = get(organizationAuthContext$);
  const q = get(queryOf(projectsContract.events));
  if (await get(projectCursorExpired(owner, q.sinceSeqId))) {
    return {
      status: 410 as const,
      body: {
        error: {
          code: "PROJECT_EVENTS_EXPIRED",
          message: "Refresh the Project snapshot",
        },
      },
    };
  }
  return {
    status: 200 as const,
    body: await get(projectEventsAfter(owner, q.sinceSeqId)),
  };
});
export const projectRoutes: readonly RouteEntry[] = [
  {
    route: projectsContract.snapshot,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:read" },
      snapshot$,
    ),
  },
  {
    route: projectsContract.events,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:read" },
      events$,
    ),
  },
  {
    route: projectsContract.list,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:read" },
      list$,
    ),
  },
  {
    route: projectsContract.threads,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:read" },
      threads$,
    ),
  },
  {
    route: projectsContract.get,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:read" },
      read$,
    ),
  },
  {
    route: projectsContract.create,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:write" },
      create$,
    ),
  },
  {
    route: projectsContract.update,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:write" },
      update$,
    ),
  },
  {
    route: projectsContract.delete,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:write" },
      remove$,
    ),
  },
  {
    route: projectsContract.membership,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "project:write" },
      membership$,
    ),
  },
];
