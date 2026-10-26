import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const binding = z.object({
  installationId: z.uuid(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  deviceToken: z.string().regex(/^(?:[0-9a-f]{2}){32,256}$/u),
  environment: z.enum(["production", "sandbox"]),
});
const responses = {
  200: z.object({ success: z.literal(true) }),
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  409: apiErrorSchema,
};

export const iosPushRegistrationsContract = c.router({
  register: {
    method: "POST",
    path: "/api/ios-push-registrations",
    headers: authHeadersSchema,
    body: binding,
    responses,
    summary: "Bind an iOS installation to its current authenticated session",
  },
  unregister: {
    method: "DELETE",
    path: "/api/ios-push-registrations",
    headers: authHeadersSchema,
    body: binding.pick({ installationId: true, revision: true }),
    responses,
    summary: "Disable this session's iOS installation binding",
  },
});
