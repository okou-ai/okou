import { WebSocket } from "miniflare";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayConnection } from "./relay-fixture";

const heartbeat = JSON.stringify({ op: 1, d: null });
const acknowledgement = JSON.stringify({ op: 11, d: null });

function createConnection() {
  const gateway = new GatewayConnection();
  const replies: string[] = [];
  gateway.client.addEventListener("message", (event) => {
    replies.push(String(event.data));
  });
  gateway.client.accept();
  onTestFinished(() => {
    if (gateway.socket.readyState === WebSocket.READY_STATE_OPEN) {
      gateway.socket.close(1000, "Test finished");
      gateway.client.close(1000, "Test finished");
    }
  });
  return { gateway, replies };
}

function queueHeartbeat(gateway: GatewayConnection) {
  const dispatch = gateway.socket.dispatchEvent.bind(gateway.socket);
  let queued: Parameters<typeof gateway.socket.dispatchEvent>[0] | undefined;
  // Hold a real peer frame at Miniflare's public dispatch boundary, then let
  // the test close the socket before the fixture's message listener runs.
  const interceptor = vi
    .spyOn(gateway.socket, "dispatchEvent")
    .mockImplementation((event) => {
      if (event.type !== "message") return dispatch(event);
      queued = event;
      return true;
    });
  onTestFinished(() => {
    interceptor.mockRestore();
  });
  gateway.client.send(heartbeat);
  interceptor.mockRestore();
  if (!queued) throw new Error("The peer heartbeat was not queued");
  const event = queued;
  return () => {
    dispatch(event);
  };
}

describe("Gateway connection fixture heartbeat replies", () => {
  it.each([true, false])(
    "honors automatic acknowledgement %s on an open socket",
    async (autoAcknowledge) => {
      const { gateway, replies } = createConnection();
      gateway.autoAcknowledge = autoAcknowledge;

      gateway.client.send(heartbeat);

      expect(await gateway.next(1)).toEqual({ op: 1, d: null });
      expect(replies).toEqual(autoAcknowledge ? [acknowledgement] : []);
    },
  );

  it("does not acknowledge a queued heartbeat after local close starts", async () => {
    const { gateway, replies } = createConnection();
    const release = queueHeartbeat(gateway);
    gateway.socket.close(1000, "Local close");
    onTestFinished(() => {
      gateway.client.close(1000, "Peer close");
    });
    expect(gateway.socket.readyState).toBe(WebSocket.READY_STATE_CLOSING);

    release();

    expect(await gateway.next(1)).toEqual({ op: 1, d: null });
    expect(replies).toEqual([]);
  });

  it("does not acknowledge a queued heartbeat after peer close starts", async () => {
    const { gateway, replies } = createConnection();
    const release = queueHeartbeat(gateway);
    gateway.client.close(1000, "Peer close");
    onTestFinished(() => {
      gateway.socket.close(1000, "Local close");
    });
    expect(gateway.socket.readyState).toBe(WebSocket.READY_STATE_CLOSING);

    release();

    expect(await gateway.next(1)).toEqual({ op: 1, d: null });
    expect(replies).toEqual([]);
    expect(await gateway.closed.promise).toEqual({
      code: 1000,
      reason: "Peer close",
    });
  });

  it("does not acknowledge a queued heartbeat after both ends close", async () => {
    const { gateway, replies } = createConnection();
    const release = queueHeartbeat(gateway);
    gateway.socket.close(1000, "Local close");
    gateway.client.close(1000, "Peer close");
    expect(gateway.socket.readyState).toBe(WebSocket.READY_STATE_CLOSED);

    release();

    expect(await gateway.next(1)).toEqual({ op: 1, d: null });
    expect(replies).toEqual([]);
    expect(await gateway.closed.promise).toEqual({
      code: 1000,
      reason: "Peer close",
    });
  });

  it("still exposes an explicit send after close", () => {
    const { gateway } = createConnection();
    gateway.socket.close(1000, "Local close");
    onTestFinished(() => {
      gateway.client.close(1000, "Peer close");
    });

    expect(() => {
      gateway.send({ op: 11, d: null });
    }).toThrow("Can't call WebSocket send() after close().");
  });
});
