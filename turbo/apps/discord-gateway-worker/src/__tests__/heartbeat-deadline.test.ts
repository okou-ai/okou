import { describe, expect, it } from "vitest";
import {
  deadlineAfterHeartbeat,
  heartbeatAckExpired,
} from "../heartbeat-deadline";

describe("Gateway heartbeat ACK deadline", () => {
  it("keeps the full ACK interval for a requested heartbeat across the next scheduled tick", () => {
    const interval = 1_500;
    // The preceding scheduled heartbeat was acknowledged before the request.
    const requestedAt = 500;
    let deadline = deadlineAfterHeartbeat(null, requestedAt, interval);

    // The next scheduled tick must not reconnect or shorten this deadline.
    const scheduledAt = 1_500;
    expect(heartbeatAckExpired(deadline, scheduledAt)).toBe(false);
    deadline = deadlineAfterHeartbeat(deadline, scheduledAt, interval);
    expect(deadline).toBe(2_000);
    expect(heartbeatAckExpired(deadline, 1_999)).toBe(false);
    expect(heartbeatAckExpired(deadline, 2_000)).toBe(true);

    // After an ACK, the following heartbeat receives its own full interval.
    deadline = deadlineAfterHeartbeat(null, 2_100, interval);
    expect(deadline).toBe(3_600);
    expect(heartbeatAckExpired(null, 3_600)).toBe(false);
  });
});
