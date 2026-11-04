/** Owned fixture transport; diagnostics never include endpoints or payloads. */
export async function openWire(endpoint) {
  const socket = new WebSocket(endpoint);
  const listeners = new Set();
  const pending = new Map();
  const commands = [];
  let sequence = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      return reject(new Error("CDP connect timeout"));
    }, 10000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("CDP unavailable"));
      },
      { once: true },
    );
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error)
        entry.reject(
          new Error(`CDP ${entry.method} failed (${message.error.code})`),
        );
      else entry.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Owned CDP connection closed"));
    }
    pending.clear();
  });
  return {
    commands,
    listeners,
    request(method, params = {}, sessionId) {
      const id = ++sequence;
      commands.push({ method, sessionId });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timeout`));
        }, 10000);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        return listeners.delete(listener);
      };
    },
    close() {
      socket.close();
    },
  };
}

/** Discover a fixture page's parent tab without guessing URL or numeric IDs. */
export async function tabTargetForPage(wire, pageTargetId) {
  const { targetInfos } = await wire.request("Target.getTargets", {
    filter: [{ exclude: false }],
  });
  for (const target of targetInfos.filter((info) => {
    return info.type === "tab";
  })) {
    const { sessionId } = await wire.request("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    let found = false;
    const off = wire.onEvent((event) => {
      if (
        event.sessionId === sessionId &&
        event.method === "Target.attachedToTarget" &&
        event.params.targetInfo.targetId === pageTargetId
      )
        found = true;
    });
    try {
      await wire.request(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId,
      );
      if (found) return target.targetId;
    } finally {
      off();
      await wire.request("Target.detachFromTarget", { sessionId });
    }
  }
  throw new Error("Owned page has no parent tab target");
}
