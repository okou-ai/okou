import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { RTCPeerConnection } from "werift";
import { exchangeComputerUseSnapshotSignal } from "../../lib/api/domains/computer-use";
import {
  isSnapshotId,
  requestSnapshotWorker,
  SnapshotInbox,
  snapshotSocket,
  type SnapshotRoute,
} from "./snapshot-channel";

function selectedRoute(pc: RTCPeerConnection): SnapshotRoute {
  const pair = pc.iceTransports[0]?.getSelectedCandidatePair();
  if (!pair?.local.type || !pair.remote.type) return "unknown";
  if (pair.local.type === "relay" || pair.remote.type === "relay")
    return "turn";
  return pair.remote.type === "prflx" ? "unknown" : "direct";
}

function serve(session: string, commandId: string) {
  const inbox = new SnapshotInbox();
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    iceUseDefaultStunServer: false,
  });
  let open = false;
  const owner = new AbortController();
  const idle = setTimeout(close, 60_000);
  const lifetime = setTimeout(close, 100_000);
  function watch(id: string) {
    inbox.watch(id);
    idle.refresh();
  }
  const server = createServer((socket) => {
    socket.on("error", () => {
      return socket.destroy();
    });
    socket.setTimeout(500, () => {
      return socket.destroy();
    });
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString();
      if (input.length > 100) {
        socket.destroy();
        return;
      }
      if (!input.endsWith("\n")) return;
      const [op, id, snap] = input.trim().split(" ");
      if (!isSnapshotId(id)) {
        socket.end();
        return;
      }
      if (op === "watch") {
        watch(id);
        socket.end(open ? "warm" : "cold");
      } else if (op === "take" && isSnapshotId(snap)) {
        socket.end(inbox.take(id, snap) ?? Buffer.alloc(0));
      } else socket.end();
    });
  });
  function close() {
    if (owner.signal.aborted) return;
    owner.abort();
    clearTimeout(idle);
    clearTimeout(lifetime);
    if (server.listening) server.close();
    void pc.close().catch(() => {
      process.exitCode = 1;
    });
  }
  pc.onDataChannel.subscribe((channel) => {
    if (
      channel.label !== "okou-snapshots-v1" ||
      !channel.ordered ||
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null
    ) {
      close();
      return;
    }
    channel.stateChange.subscribe((state) => {
      open = state === "open";
      if (state === "closed") close();
    });
    open = channel.readyState === "open";
    channel.onMessage.subscribe((data) => {
      return inbox.receive(data, selectedRoute(pc));
    });
  });
  pc.connectionStateChange.subscribe((state) => {
    if (state === "failed" || state === "closed") close();
  });
  server.once("error", (error: NodeJS.ErrnoException) => {
    close();
    if (error.code === "EADDRINUSE") {
      void requestSnapshotWorker(session, "watch " + commandId).catch(() => {
        return undefined;
      });
    }
  });
  server.listen(snapshotSocket(session), () => {
    watch(commandId);
    void negotiate().catch(close);
  });
  async function negotiate() {
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
    let offer: string | null;
    do {
      offer = await exchangeComputerUseSnapshotSignal(
        commandId,
        undefined,
        signal,
      );
      if (!offer) await delay(250, undefined, { signal });
    } while (!offer);
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    signal.throwIfAborted();
    const answer = pc.localDescription?.sdp;
    if (!answer) throw new Error("Missing snapshot answer");
    await exchangeComputerUseSnapshotSignal(commandId, answer, signal);
  }
}
const [session, firstCommand] = process.argv.slice(2);
if (session && session.length <= 160 && isSnapshotId(firstCommand))
  serve(session, firstCommand);
