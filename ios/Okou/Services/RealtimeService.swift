import Ably
import Foundation

/// Notifications invalidate durable API reads; no transient output is rendered.
@MainActor
final class RealtimeService {
  private let userID: String
  private let workspaceID: String
  private let tokenProvider: @Sendable () async throws -> Data
  private let onChange: @MainActor () -> Void
  private let onConnection: @MainActor (String) -> Void
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
    onChange: @escaping @MainActor () -> Void,
    onConnection: @escaping @MainActor (String) -> Void
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
        if state == .connected { onChange() }
      }
    }
    for name in channelNames {
      let channel = realtime.channels.get(name)
      channel.subscribe { [weak self] message in
        let name = message.name ?? ""
        guard
          name == "threadListChanged" || name == "chatThreadReadCursorUpdated"
            || name.hasPrefix("chatThreadMessageCreated:")
            || name.hasPrefix("chatThreadDetailChanged:")
        else { return }
        Task { @MainActor [weak self] in
          guard let self, self.generation == generation else { return }
          onChange()
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
          if state == .attached { onChange() }
        }
      }
    }
    realtime.connect()
  }

  private func reportAvailability() {
    switch connectionAvailability {
    case .disconnected:
      onConnection("Disconnected")
    case .unavailable:
      onConnection("Live updates unavailable. Pull to refresh.")
    case .connecting:
      onConnection("Connecting")
    case .connected:
      if channelNames.allSatisfy({ channelAvailability[$0] == .connected }) {
        onConnection("Connected")
      } else if channelAvailability.values.contains(.unavailable) {
        onConnection("Live updates unavailable. Pull to refresh.")
      } else {
        onConnection("Connecting")
      }
    }
  }

  func stop() {
    generation = UUID()
    realtime?.close()
    realtime = nil
  }
}
