import { int, strictObject, string, uuid } from "zod";

export const remoteHostIdentitySchema = strictObject({
  id: uuid(),
  createdAt: string().datetime(),
  generation: int().positive().max(2_147_483_647),
});
