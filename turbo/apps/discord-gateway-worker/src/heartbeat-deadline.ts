// One outstanding heartbeat retains its original deadline when another request
// or scheduled tick sends a heartbeat before an ACK arrives.
export function deadlineAfterHeartbeat(
  deadline: number | null,
  sentAt: number,
  interval: number,
): number {
  return deadline ?? sentAt + interval;
}

export function heartbeatAckExpired(
  deadline: number | null,
  now: number,
): boolean {
  return deadline !== null && now >= deadline;
}
