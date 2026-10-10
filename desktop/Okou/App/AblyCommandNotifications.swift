import Ably
import Foundation
import OkouCore

@MainActor
final class AblyCommandNotifications: CommandNotifications {
  private var realtime: ARTRealtime?
  private var subscription: CommandNotificationSubscription?
  private var tokenProvider: (@Sendable () async throws -> JSONValue)?
  private var continuation: AsyncStream<CommandNotificationEvent>.Continuation?
  private var generation = UUID()
  private var recoveryAttempt = 0
  private var recoveryTask: Task<Void, Never>?
  private var authenticationTasks: [UUID: Task<Void, Never>] = [:]
  private var lastUnavailable: String?

  func start(
    subscription: CommandNotificationSubscription,
    tokenProvider: @escaping @Sendable () async throws -> JSONValue
  ) async throws -> AsyncStream<CommandNotificationEvent> {
    try Task.checkCancellation()
    await stop()
    try Task.checkCancellation()
    self.subscription = subscription
    self.tokenProvider = tokenProvider
    let stream = AsyncStream<CommandNotificationEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(1))
    continuation = stream.continuation
    connect()
    return stream.stream
  }

  private func connect() {
    guard let subscription, tokenProvider != nil, continuation != nil else { return }
    generation = UUID()
    let expected = generation
    for task in authenticationTasks.values { task.cancel() }
    authenticationTasks.removeAll()
    realtime?.close()
    let options = ARTClientOptions()
    options.autoConnect = false
    options.useTokenAuth = true
    options.authCallback = { [weak self] _, completion in
      Task { @MainActor [weak self] in
        guard let self, generation == expected, let tokenProvider else { return }
        let id = UUID()
        authenticationTasks[id] = Task { @MainActor [weak self] in
          do {
            let value = try await tokenProvider()
            try Task.checkCancellation()
            guard let self, generation == expected else { return }
            let data = try JSONEncoder().encode(value)
            guard let json = String(data: data, encoding: .utf8) else {
              throw DesktopFailure("invalid_response", "Invalid realtime token response")
            }
            let request = try ARTTokenRequest.fromJson(json as ARTJsonCompatible)
            completion(request, nil)
          } catch {
            if let self, generation == expected, !Task.isCancelled {
              completion(nil, error)
            }
          }
          self?.authenticationTasks[id] = nil
        }
      }
    }
    let realtime = ARTRealtime(options: options)
    self.realtime = realtime
    let channel = realtime.channels.get(subscription.channelName)
    channel.subscribe(subscription.eventName) { [weak self] _ in
      Task { @MainActor [weak self] in
        guard let self, generation == expected else { return }
        continuation?.yield(.refresh)
      }
    }
    channel.on { [weak self] change in
      let state = change.current
      let message = change.reason?.message
      Task { @MainActor [weak self] in
        guard let self, generation == expected else { return }
        switch state {
        case .attached:
          // Covers initial attachment, reattachment, and UPDATE continuity gaps.
          refreshWhenReady()
        case .failed:
          unavailable(message ?? "Command notification subscription failed")
          recover(generation: expected)
        case .suspended, .detached:
          unavailable(message ?? "Command notifications are temporarily unavailable")
        default: break
        }
      }
    }
    realtime.connection.on { [weak self] change in
      let state = change.current
      let message = change.reason?.message
      Task { @MainActor [weak self] in
        guard let self, generation == expected else { return }
        switch state {
        case .connected: refreshWhenReady()
        case .failed:
          unavailable(message ?? "Command notification connection failed")
          recover(generation: expected)
        case .disconnected, .suspended:
          unavailable(message ?? "Command notifications are temporarily unavailable")
        default: break
        }
      }
    }
    realtime.connect()
  }

  private func refreshWhenReady() {
    guard let realtime, let subscription,
      realtime.connection.state == .connected,
      realtime.channels.get(subscription.channelName).state == .attached
    else { return }
    recoveryAttempt = 0
    recoveryTask?.cancel()
    recoveryTask = nil
    lastUnavailable = nil
    continuation?.yield(.refresh)
  }

  private func unavailable(_ message: String) {
    guard lastUnavailable != message else { return }
    lastUnavailable = message
    continuation?.yield(.unavailable(message))
  }

  private func recover(generation expected: UUID) {
    guard recoveryTask == nil else { return }
    recoveryAttempt += 1
    let delay = min(60, 2 * pow(2, Double(min(recoveryAttempt - 1, 5))))
    recoveryTask = Task { @MainActor [weak self] in
      do { try await Task.sleep(for: .seconds(delay)) } catch { return }
      guard let self, generation == expected, continuation != nil else { return }
      recoveryTask = nil
      connect()
    }
  }

  func stop() async {
    generation = UUID()
    recoveryTask?.cancel()
    recoveryTask = nil
    realtime?.close()
    realtime = nil
    let tasks = Array(authenticationTasks.values)
    authenticationTasks.removeAll()
    for task in tasks { task.cancel() }
    for task in tasks { await task.value }
    continuation?.finish()
    continuation = nil
    subscription = nil
    tokenProvider = nil
    recoveryAttempt = 0
    lastUnavailable = nil
  }
}
