import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { phoneUseDevices } from "@okouai/db/schema/phone-use";
import { phoneUseChannel } from "@okouai/api-contracts/contracts/phone-use";
import { db$ } from "../external/db";
import {
  publishPhoneUseDevicesChanged,
  publishPhoneUseHint,
} from "../external/realtime";

/** Wake both the old and new selection; notifications never convey authority. */
export const notifyPhoneUseOwner$ = command(
  async (
    { get },
    owner: { orgId: string; userId: string },
    signal: AbortSignal,
  ) => {
    const devices = await get(db$)
      .select({
        id: phoneUseDevices.id,
        generation: phoneUseDevices.generation,
      })
      .from(phoneUseDevices)
      .where(
        and(
          eq(phoneUseDevices.orgId, owner.orgId),
          eq(phoneUseDevices.userId, owner.userId),
        ),
      );
    signal.throwIfAborted();
    await Promise.all(
      devices.map((device) => {
        return publishPhoneUseHint(
          phoneUseChannel(
            owner.orgId,
            owner.userId,
            device.id,
            device.generation,
          ),
          signal,
        );
      }),
    );
    signal.throwIfAborted();
    if (devices.length > 0) {
      await publishPhoneUseDevicesChanged(owner);
    }
  },
);
