import { boolean, number, object, url } from "zod";

export const publicConnectorCatalogIconSchema = object({
  url: url({ protocol: /^https$/u }).max(2048),
  invertInDarkMode: boolean(),
  scale: number().min(1).max(3).optional(),
});
