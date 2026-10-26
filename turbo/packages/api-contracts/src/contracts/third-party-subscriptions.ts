import { array, object } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { modelProviderResponseSchema } from "./model-providers";

const c = initContract();

export const thirdPartySubscriptionsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/me/3rd-party-subscriptions",
    headers: authHeadersSchema,
    responses: {
      200: object({ subscriptions: array(modelProviderResponseSchema) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List the requesting user's personal third-party subscriptions",
  },
});

export type ThirdPartySubscriptionsMainContract =
  typeof thirdPartySubscriptionsMainContract;
