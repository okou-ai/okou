import { settle } from "../utils";
import { command, computed } from "ccstate";
import { chatFoldersContract as contract } from "@okouai/api-contracts/contracts/chat-folders";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import {
  badRequestMessage,
  conflict,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { publishChatFoldersChangedSafely } from "../external/realtime";
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  chatFolderCatalog,
  createChatFolder$,
  deleteChatFolder$,
  moveThreadToChatFolder$,
  renameChatFolder$,
  reorderChatFolder$,
} from "../services/chat-folders.service";
import type { RouteEntry } from "../route-entry";

const identity$ = computed((get) => {
  return Promise.resolve(get(organizationAuthContext$));
});
const switchContext$ = createUserFeatureSwitchContext(identity$);
const enabled$ = computed(async (get) => {
  return isFeatureEnabled(
    FeatureSwitchKey.ChatThreadFolders,
    await get(switchContext$),
  );
});
const catalogScope$ = computed((get) => {
  return {
    ...get(organizationAuthContext$),
    agentId: get(pathParamsOf(contract.list)).agentId,
  };
});
const catalog$ = chatFolderCatalog(catalogScope$);
function unavailable() {
  return resourceUnavailable("Chat folders are not available");
}
function missing() {
  return notFound("Chat folder or conversation not found");
}

const list$ = computed(async (get) => {
  if (!(await get(enabled$))) {
    return unavailable();
  }
  const catalog = await get(catalog$);
  return catalog ? { status: 200 as const, body: catalog } : missing();
});

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return unavailable();
  }
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(contract.create));
  const body = await get(bodyResultOf(contract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const scope = { ...auth, agentId: params.agentId };
  const result = await settle(
    set(createChatFolder$, { ...scope, ...body.data }, signal),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    if (isForeignKeyViolation(result.error)) {
      return missing();
    }
    throw result.error;
  }
  const folder = result.value;
  if (folder === "missing") {
    return missing();
  }
  if (!folder) {
    return conflict("A folder with this name or identity already exists");
  }
  await publishChatFoldersChangedSafely(auth, scope.agentId);
  signal.throwIfAborted();
  return { status: 201 as const, body: folder };
});

const rename$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return unavailable();
  }
  const auth = get(organizationAuthContext$);
  const { id } = get(pathParamsOf(contract.rename));
  const body = await get(bodyResultOf(contract.rename));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await settle(
    set(renameChatFolder$, { ...auth, id, name: body.data.name }, signal),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    if (isUniqueViolation(result.error, "uq_chat_thread_folders_scope_name")) {
      return conflict("A folder with this name already exists");
    }
    throw result.error;
  }
  if (!result.value) {
    return missing();
  }
  await publishChatFoldersChangedSafely(auth, result.value.agentId);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return unavailable();
  }
  const auth = get(organizationAuthContext$);
  const { id } = get(pathParamsOf(contract.delete));
  const folder = await set(deleteChatFolder$, { ...auth, id }, signal);
  if (!folder) {
    return missing();
  }
  await publishChatFoldersChangedSafely(auth, folder.agentId);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const reorder$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return unavailable();
  }
  const auth = get(organizationAuthContext$);
  const { id } = get(pathParamsOf(contract.reorder));
  const body = await get(bodyResultOf(contract.reorder));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    reorderChatFolder$,
    { ...auth, id, ...body.data },
    signal,
  );
  if (result === "missing") {
    return missing();
  }
  if (result === "invalid") {
    return badRequestMessage("Choose neighboring folders in the same Agent");
  }
  await publishChatFoldersChangedSafely(auth, result);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const move$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return unavailable();
  }
  const auth = get(organizationAuthContext$);
  const { id } = get(pathParamsOf(contract.moveThread));
  const body = await get(bodyResultOf(contract.moveThread));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await settle(
    set(
      moveThreadToChatFolder$,
      {
        ...auth,
        threadId: id,
        folderId: body.data.folderId,
      },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    // A destination/thread deletion can win after the INSERT source was read.
    // The membership FKs reject that race without leaving a dangling row.
    if (isForeignKeyViolation(result.error)) {
      return missing();
    }
    throw result.error;
  }
  if (!result.value) {
    return missing();
  }
  await publishChatFoldersChangedSafely(auth, result.value);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-thread:read",
  oauthScope: "okou:chat:read",
} as const;
const writeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-thread:write",
  oauthScope: "okou:chat:manage",
} as const;
export const chatFolderRoutes: readonly RouteEntry[] = [
  { route: contract.list, handler: authRoute(readAuth, list$) },
  { route: contract.create, handler: authRoute(writeAuth, create$) },
  { route: contract.rename, handler: authRoute(writeAuth, rename$) },
  { route: contract.reorder, handler: authRoute(writeAuth, reorder$) },
  { route: contract.delete, handler: authRoute(writeAuth, remove$) },
  { route: contract.moveThread, handler: authRoute(writeAuth, move$) },
];
