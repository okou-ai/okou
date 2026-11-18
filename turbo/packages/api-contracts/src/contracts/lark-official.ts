import {
  boolean,
  literal,
  object,
  string,
  unknown as zUnknown,
  uuid,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const larkOfficialContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/integrations/lark/official",
    headers: authHeadersSchema,
    responses: {
      200: object({
        isConfigured: boolean(),
        isConnected: boolean(),
        connectedUserName: string().nullable(),
        installationId: uuid().nullable(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Check the Okou Official Lark bot connection",
  },
  connect: {
    method: "POST",
    path: "/api/integrations/lark/official/connect",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: object({ authorizationUrl: string() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Connect to the Okou Official Lark bot",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/integrations/lark/official/connect",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: object({ success: literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect from the Okou Official Lark bot",
  },
});

export const larkOfficialEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/lark/official/events",
    body: c.type<string>(),
    responses: {
      200: zUnknown(),
      400: object({ error: string() }),
      401: object({ error: string() }),
      404: object({ error: string() }),
      503: object({ error: string() }),
    },
    summary: "Handle Okou Official Lark application events",
  },
});
