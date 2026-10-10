import ClerkKit
import Foundation
import Observation
import OkouCore

@MainActor
final class ClerkSessionSource: DesktopSessionSource {
  private var continuation: AsyncStream<DesktopSessionSnapshot>.Continuation?
  private var eventTask: Task<Void, Never>?
  private var generation = UUID()
  private var terminalSignedOut = false
  private var lastSnapshot: DesktopSessionSnapshot?

  var snapshot: DesktopSessionSnapshot {
    let clerk = Clerk.shared
    let session = clerk.session
    let user = clerk.user
    let identity: DesktopSessionIdentity?
    if let session, let user {
      identity = DesktopSessionIdentity(
        userId: user.id, sessionId: session.id,
        organizationId: session.lastActiveOrganizationId)
    } else {
      identity = nil
    }
    return DesktopSessionSnapshot(
      // Identity availability depends on the client, not optional environment/UI resources.
      loaded: clerk.client != nil || (terminalSignedOut && session == nil),
      active: session?.status == .active,
      identity: identity,
      email: user?.primaryEmailAddress?.emailAddress,
      organizationName: clerk.organization?.name)
  }

  func updates() -> AsyncStream<DesktopSessionSnapshot> {
    stop()
    let expected = generation
    let stream = AsyncStream<DesktopSessionSnapshot>.makeStream(
      bufferingPolicy: .bufferingNewest(1))
    continuation = stream.continuation
    let events = Clerk.shared.auth.events
    eventTask = Task { [weak self] in
      for await event in events {
        guard let self, generation == expected, !Task.isCancelled else { return }
        switch event {
        case .signedOut, .accountDeleted: terminalSignedOut = true
        default:
          if Clerk.shared.session != nil { terminalSignedOut = false }
        }
        emitSnapshot()
      }
    }
    observeSnapshot(generation: expected)
    emitSnapshot()
    return stream.stream
  }

  private func observeSnapshot(generation expected: UUID) {
    _ = withObservationTracking {
      snapshot
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, generation == expected, continuation != nil else { return }
        // Observation covers initial loading and profile changes that are not auth events.
        observeSnapshot(generation: expected)
        emitSnapshot()
      }
    }
  }

  private func emitSnapshot() {
    let value = snapshot
    guard value != lastSnapshot else { return }
    lastSnapshot = value
    continuation?.yield(value)
  }

  func token(forceRefresh: Bool) async throws -> String? {
    try await Clerk.shared.auth.getToken(.init(skipCache: forceRefresh))
  }

  func refresh() async throws { _ = try await Clerk.shared.refreshClient() }

  func stop() {
    generation = UUID()
    eventTask?.cancel()
    eventTask = nil
    continuation?.finish()
    continuation = nil
    lastSnapshot = nil
  }
}
