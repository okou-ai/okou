import type { infer as zInfer } from "zod";
import { hostedSiteDeliveryPointerSchema } from "@okouai/api-contracts/contracts/host";

/**
 * Older public pointers predate the layout marker (`publicBrand`, legacy when
 * absent) and the deployment version.
 */
export const hostedSitePointerSchema = hostedSiteDeliveryPointerSchema;

export type HostedSitePointer = zInfer<typeof hostedSitePointerSchema>;
