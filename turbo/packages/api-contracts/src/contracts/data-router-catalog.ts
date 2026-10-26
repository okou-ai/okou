import { initContract } from "./base";
import { array, object, string } from "zod";
import { apiErrorSchema } from "./api-error";
import { dataRouterToolSchema } from "./data-router-tools";

const c = initContract();

/** Settings reads the current MCP catalog through the authenticated Okou API. */
export const dataRouterToolsContract = c.router({
  list: {
    method: "GET",
    path: "/api/data/router/tools",
    headers: object({ authorization: string().optional() }),
    responses: {
      200: object({ tools: array(dataRouterToolSchema) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Discover managed Data Router tools and their current input schemas",
  },
});
