import type { z } from "zod";
import { hostedSiteDeliveryPointerSchema } from "@okouai/api-contracts/contracts/host";

/**
 * Older public pointers predate the layout marker (`publicBrand`, legacy when
 * absent) and the deployment version.
 */
export const hostedSitePointerSchema = hostedSiteDeliveryPointerSchema;

export type HostedSitePointer = z.infer<typeof hostedSitePointerSchema>;
