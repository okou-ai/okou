export const phoneUseDevicesChangedEvent = "phoneUseDevicesChanged";
export const phoneUseResultChangedEvent = "resultChanged";
export function phoneUseResultChannel(
  orgId: string,
  userId: string,
  operationId: string,
) {
  return `phone-use-result:${orgId}:${userId}:${operationId}`;
}

export function phoneUseChannel(
  orgId: string,
  userId: string,
  deviceId: string,
  generation: number,
) {
  return `phone-use:${orgId}:${userId}:${deviceId}:${generation}`;
}
