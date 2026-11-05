import Ably
import ChatData
import Foundation

/// Notifications invalidate durable API reads. The one transient exception is a running
/// run's text output, which streams on its own channel until the durable event replaces it.
@MainActor
final class RealtimeService {
  /// One chunk of an assistant message while its run is live (`sessionOutputDeltaSchema`).
  struct RunOutputDelta: Sendable {
    let threadID: String
    let runID: String
    let eventID: String
    let chunkIndex: Int
    let delta: String
  }

  private let userID: String
  private let workspaceID: String
  private let tokenProvider: @Sendable () async throws -> Data
  private let onChange: @MainActor (ChatInvalidation) -> Void
  private let onConnection: @MainActor (RealtimeConnectionStatus) -> Void
  private var isForeground = false
  private var realtime: ARTRealtime?
  private var generation = UUID()
  private var connectionAvailability = Availability.connecting
  private var channelAvailability: [String: Availability] = [:]

  private enum Availability {
    case connecting, connected, unavailable, disconnected
  }

  private var channelNames: [String] {
    ["user-org:\(userID):\(workspaceID)", "user:\(userID)"]
  }

  init(
    userID: String, workspaceID: String,
    tokenProvider: @escaping @Sendable () async throws -> Data,
    onChange: @escaping @MainActor (ChatInvalidation) -> Void,
    onConnection: @escaping @MainActor (RealtimeConnectionStatus) -> Void
  ) {
    self.userID = userID
    self.workspaceID = workspaceID
    self.tokenProvider = tokenProvider
    self.onChange = onChange
    self.onConnection = onConnection
  }

  func start() {
    guard realtime == nil else { return }
    let generation = generation
    connectionAvailability = .connecting
    channelAvailability = Dictionary(uniqueKeysWithValues: channelNames.map { ($0, .connecting) })
    reportAvailability()
    let options = ARTClientOptions()
    options.autoConnect = false
    options.clientId = userID
    options.useTokenAuth = true
    options.authCallback = { [tokenProvider] _, completion in
      Task {
        do {
          let data = try await tokenProvider()
          guard let json = String(data: data, encoding: .utf8) else {
            throw APIClientError.invalidResponse
          }
          let request = try ARTTokenRequest.fromJson(json as ARTJsonCompatible)
          completion(request, nil)
        } catch { completion(nil, error) }
      }
    }
    let realtime = ARTRealtime(options: options)
    self.realtime = realtime
    realtime.connection.on { [weak self] change in
      let state = change.current
      Task { @MainActor [weak self] in
        guard let self, self.generation == generation else { return }
        switch state {
        case .connected: connectionAvailability = .connected
        case .connecting, .initialized: connectionAvailability = .connecting
        case .closing, .closed: connectionAvailability = .disconnected
        case .disconnected, .suspended, .failed: connectionAvailability = .unavailable
        @unknown default: connectionAvailability = .connecting
        }
        reportAvailability()
        if state == .connected {
          reconcilePresence()
          onChange(.reconnected)
        }
      }
    }
    for name in channelNames {
      let channel = realtime.channels.get(name)
      channel.subscribe { [weak self] message in
        guard let invalidation = ChatInvalidation(notification: message.name ?? "") else { return }
        Task { @MainActor [weak self] in
          guard let self, self.generation == generation else { return }
          onChange(invalidation)
        }
      }
      channel.on { [weak self] change in
        let state = change.current
        Task { @MainActor [weak self] in
          guard let self, self.generation == generation else { return }
          switch state {
          case .attached: channelAvailability[name] = .connected
          case .initialized, .attaching: channelAvailability[name] = .connecting
          case .detaching, .detached, .failed, .suspended:
            channelAvailability[name] = .unavailable
          @unknown default: channelAvailability[name] = .unavailable
          }
          reportAvailability()
          if state == .attached { onChange(.reconnected) }
        }
      }
    }
    realtime.connect()
  }

  private func reportAvailability() {
    switch connectionAvailability {
    case .disconnected:
      onConnection(.disconnected)
    case .unavailable:
      onConnection(.unavailable)
    case .connecting:
      onConnection(.connecting)
    case .connected:
      if channelNames.allSatisfy({ channelAvailability[$0] == .connected }) {
        onConnection(.connected)
      } else if channelAvailability.values.contains(.unavailable) {
        onConnection(.unavailable)
      } else {
        onConnection(.connecting)
      }
    }
  }

  func setForeground(_ active: Bool) {
    isForeground = active
    reconcilePresence()
  }

  private func reconcilePresence() {
    guard let realtime, realtime.connection.state == .connected else { return }
    let presence = realtime.channels.get("user-org-foreground:\(userID):\(workspaceID)").presence
    if isForeground { presence.enter(nil) } else { presence.leave(nil) }
  }

  /// Streams one run's text. The channel and capability are the ones the web uses; the
  /// returned closure detaches it. Deltas carry the id of the event that will persist them.
  func subscribeRunOutput(
    runID: String, handler: @escaping @MainActor @Sendable (RunOutputDelta) -> Void
  ) -> (@MainActor () -> Void)? {
    guard let realtime else { return nil }
    let name = "run-output:\(userID):\(workspaceID):\(runID)"
    let channel = realtime.channels.get(name)
    let generation = generation
    channel.subscribe(runID) { [weak self] message in
      guard let delta = Self.decodeDelta(message.data) else { return }
      Task { @MainActor [weak self] in
        guard let self, self.generation == generation else { return }
        handler(delta)
      }
    }
    return { [weak self] in
      channel.unsubscribe()
      channel.detach()
      self?.realtime?.channels.release(name)
    }
  }

  nonisolated private static func decodeDelta(_ data: Any?) -> RunOutputDelta? {
    var object = data as? [String: Any]
    if object == nil, let text = data as? String,
      let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    {
      object = json
    }
    guard let object, let threadID = object["threadId"] as? String,
      let runID = object["runId"] as? String, let eventID = object["eventId"] as? String,
      let delta = object["delta"] as? String,
      let chunkIndex = (object["chunkIndex"] as? NSNumber)?.intValue, chunkIndex >= 0
    else { return nil }
    return RunOutputDelta(
      threadID: threadID.lowercased(), runID: runID.lowercased(), eventID: eventID.lowercased(),
      chunkIndex: chunkIndex, delta: delta)
  }

  func stop() {
    isForeground = false
    reconcilePresence()
    generation = UUID()
    realtime?.close()
    realtime = nil
  }
}
