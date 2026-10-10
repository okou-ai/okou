/** External Ably transport controlled by command integration tests. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class Events {
  private readonly listeners = new Map<string, Set<() => void>>();
  on(events: string | readonly string[], listener: () => void) {
    for (const event of typeof events === "string" ? [events] : events) {
      const listeners = this.listeners.get(event) ?? new Set<() => void>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    }
  }
  off(listener: () => void) {
    for (const listeners of this.listeners.values()) listeners.delete(listener);
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

export const ablyRealtimeFake = {
  mode: "attached" as "attached" | "pending" | "failed",
  clients: [] as FakeRealtime[],
  created: deferred<FakeRealtime>(),
  reset() {
    this.mode = "attached";
    this.clients = [];
    this.created = deferred<FakeRealtime>();
  },
};

export class FakeRealtime {
  readonly connection = Object.assign(new Events(), { state: "initialized" });
  readonly channel = Object.assign(new Events(), {
    state: "initialized",
    subscribe: async (event: string, listener: () => void) => {
      this.eventName = event;
      this.listener = listener;
      this.subscribed.resolve();
      if (ablyRealtimeFake.mode === "failed") {
        throw new Error("Ably authorization unavailable");
      }
      if (ablyRealtimeFake.mode === "attached") this.attach();
      await this.attachment.promise;
    },
    unsubscribe: (_event: string, _listener: () => void) => {
      this.listener = undefined;
    },
  });
  readonly channels = {
    get: (name: string) => {
      this.channelName = name;
      return this.channel;
    },
  };
  readonly subscribed = deferred<void>();
  private readonly attachment = deferred<void>();
  private listener: (() => void) | undefined;
  channelName = "";
  eventName = "";
  closed = false;

  constructor() {
    ablyRealtimeFake.clients.push(this);
    ablyRealtimeFake.created.resolve(this);
  }
  connect() {
    this.connection.state = "connected";
    this.connection.emit("connected");
  }
  attach() {
    this.channel.state = "attached";
    this.channel.emit("attached");
    this.attachment.resolve();
  }
  publish() {
    this.listener?.();
  }
  disconnect() {
    this.connection.state = "disconnected";
    this.connection.emit("disconnected");
  }
  reconnect() {
    this.connect();
  }
  close() {
    this.closed = true;
    this.connection.state = "closed";
    this.attachment.resolve();
  }
}
