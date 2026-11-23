import { object, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { presentationOutputFormatSchema } from "../validators/presentation-output-format";

const c = initContract();

export const presentationFormatResponseSchema = object({
  presentationFormat: presentationOutputFormatSchema.nullable(),
});

export type PresentationFormatResponse = zInfer<
  typeof presentationFormatResponseSchema
>;

export const presentationFormatContract = c.router({
  get: {
    method: "GET",
    path: "/api/presentation-format",
    headers: authHeadersSchema,
    responses: {
      200: presentationFormatResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Get the current workspace member's presentation format preference",
  },
});

export type PresentationFormatContract = typeof presentationFormatContract;
