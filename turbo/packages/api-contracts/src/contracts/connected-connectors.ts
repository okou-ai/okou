import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import {
  builtinConnectorBriefSchema,
  customConnectorBriefSchema,
} from "./connector-overview";
import { apiErrorSchema } from "./errors";

const c = initContract();

// Saved accounts provide directory visibility, not execution authorization.
export const connectedConnectorsSchema = z.object({
  builtinConnectors: z.array(builtinConnectorBriefSchema),
  customConnectors: z.array(customConnectorBriefSchema),
});

export type ConnectedConnectors = z.infer<typeof connectedConnectorsSchema>;

export const connectedConnectorsContract = c.router({
  list: {
    method: "GET",
    path: "/api/connectors/connected",
    headers: authHeadersSchema,
    responses: {
      200: connectedConnectorsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List connector briefs for the user's saved accounts",
  },
});
