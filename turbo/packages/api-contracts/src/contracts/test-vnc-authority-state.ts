import { z } from "zod";
import { initContract } from "./base";

const c = initContract();
const ownerConnection = {
  orgId: z.string().min(1),
  userId: z.string().min(1),
  connectionId: z.uuid(),
};

export const testVncAuthorityStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/vnc-authority-state/action",
    body: z
      .object({
        action: z.enum([
          "hold-connection-lock",
          "read-connection-lock",
          "release-connection-lock",
        ]),
        ...ownerConnection,
      })
      .strict(),
    responses: {
      200: z
        .object({
          ok: z.literal(true),
          held: z.boolean().optional(),
          waiting: z.boolean().optional(),
        })
        .strict(),
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Construct owned database contention for VNC lifecycle tests",
  },
});

export type TestVncAuthorityStateAction = z.infer<
  typeof testVncAuthorityStateContract.action.body
>;
