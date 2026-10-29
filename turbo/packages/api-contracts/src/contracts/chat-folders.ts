import { array, object, string, type infer as Infer } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const name = string().trim().min(1).max(100);
const folder = object({ id: string().uuid(), name, sortKey: string() });
const chatFolderCatalogSchema = object({
  folders: array(folder),
  memberships: array(
    object({ chatThreadId: string().uuid(), folderId: string().uuid() }),
  ),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
};
const c = initContract();
export const chatFoldersContract = c.router({
  list: {
    method: "GET",
    path: "/api/agents/:agentId/chat-folders",
    headers: authHeadersSchema,
    pathParams: object({ agentId: string().uuid() }),
    responses: { 200: chatFolderCatalogSchema, ...errors },
  },
  create: {
    method: "POST",
    path: "/api/agents/:agentId/chat-folders",
    headers: authHeadersSchema,
    pathParams: object({ agentId: string().uuid() }),
    body: object({ id: string().uuid(), name }),
    responses: { 201: folder, ...errors },
  },
  rename: {
    method: "PATCH",
    path: "/api/chat-folders/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    body: object({ name }),
    responses: { 204: c.noBody(), ...errors },
  },
  reorder: {
    method: "PATCH",
    path: "/api/chat-folders/:id/order",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    body: object({
      beforeId: string().uuid().nullable(),
      afterId: string().uuid().nullable(),
    }),
    responses: { 204: c.noBody(), ...errors },
  },
  delete: {
    method: "DELETE",
    path: "/api/chat-folders/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    body: c.noBody(),
    responses: { 204: c.noBody(), ...errors },
  },
  moveThread: {
    method: "PUT",
    path: "/api/chat-threads/:id/folder",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    body: object({ folderId: string().uuid().nullable() }),
    responses: { 204: c.noBody(), ...errors },
  },
});
export type ChatFolder = Infer<typeof folder>;
export type ChatFolderCatalog = Infer<typeof chatFolderCatalogSchema>;
export function chatFoldersChangedEvent(agentId: string): string {
  return `chatFoldersChanged:${agentId}`;
}
