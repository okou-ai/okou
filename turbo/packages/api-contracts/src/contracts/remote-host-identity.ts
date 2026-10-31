import { int, iso, strictObject, uuid } from "zod";

export const remoteHostIdentitySchema = strictObject({
  id: uuid(),
  createdAt: iso.datetime(),
  generation: int().positive().max(2_147_483_647),
});
