import Ably
import Foundation

/// Notifications invalidate durable API reads; no transient output is rendered.
@MainActor
final class RealtimeService {
  private let userID: String
  private let workspaceID: String
  private let tokenProvider: @Sendable () async throws -> Data
  private let onChange: @MainActor (ChatInvalidation) -> Void
  private let onConnection: @MainActor (RealtimeConnectionStatus) -> Void
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
        if state == .connected { onChange(.reconnected) }
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

  func stop() {
    generation = UUID()
    realtime?.close()
    realtime = nil
  }
}
