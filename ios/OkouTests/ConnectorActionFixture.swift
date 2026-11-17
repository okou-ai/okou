import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

final class ConnectorPollingClock: Sendable {
  private struct Sleeper: Sendable {
    let duration: Duration
    let tick: AsyncStream<Void>.Continuation
  }
  private let sleepers = Mutex<[UUID: Sleeper]>([:])
  private let didSchedule: @Sendable (Duration) -> Void
  private let didCancel: @Sendable (Duration) -> Void

  init(
    didSchedule: @escaping @Sendable (Duration) -> Void,
    didCancel: @escaping @Sendable (Duration) -> Void = { _ in }
  ) {
    self.didSchedule = didSchedule
    self.didCancel = didCancel
  }

  func sleep(_ duration: Duration) async throws {
    try Task.checkCancellation()
    let id = UUID()
    let ticks = AsyncStream<Void>.makeStream()
    sleepers.withLock { $0[id] = Sleeper(duration: duration, tick: ticks.continuation) }
    defer {
      _ = sleepers.withLock { $0.removeValue(forKey: id) }
      ticks.continuation.finish()
      if Task.isCancelled { didCancel(duration) }
    }
    didSchedule(duration)
    for await _ in ticks.stream { break }
    try Task.checkCancellation()
  }

  func advance(_ duration: Duration) {
    let ready = sleepers.withLock { value in
      let ready = value.filter { $0.value.duration == duration }
      for id in ready.keys { value.removeValue(forKey: id) }
      return ready.values.map(\.tick)
    }
    for tick in ready {
      tick.yield(())
      tick.finish()
    }
  }
}

struct ConnectorCardHarness: View {
  let action: ChatConnectorAction
  let store: ConnectorActionStore
  var body: some View {
    ConnectorActionCard(action: action, store: store, loadsState: false)
      .sheet(
        item: Binding(get: { store.active }, set: { if $0 == nil { store.cancel() } })
      ) { flow in
        ConnectorAuthorizationSheet(flow: flow, store: store)
      }
  }
}
