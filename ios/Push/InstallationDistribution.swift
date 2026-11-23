import ChatData
import Foundation
import MarketplaceKit

/// Each process resolves its own installation. A new launch, including a same-build
/// reinstall from another distributor, never reuses a previous process's answer.
actor InstallationDistribution {
  static let shared = InstallationDistribution()
  private var lookup: Task<ClientDistribution, Never>?

  func current(retryUnknown: Bool = false) async -> ClientDistribution {
    if let lookup {
      let previous = await lookup.value
      if !retryUnknown || previous != .unknown { return previous }
    }
    let lookup = Task { await Self.resolve() }
    self.lookup = lookup
    return await lookup.value
  }

  private static func resolve() async -> ClientDistribution {
    let (values, result) = AsyncStream<ClientDistribution>.makeStream()
    let lookup = Task {
      do {
        switch try await AppDistributor.current {
        case .appStore: result.yield(.appStore)
        case .testFlight: result.yield(.testFlight)
        default: result.yield(.unknown)
        }
      } catch {
        result.yield(.unknown)
      }
      result.finish()
    }
    // An unresponsive system service must not hold authenticated requests open.
    let timeout = Task {
      try await Task.sleep(for: .seconds(1))
      result.finish()
    }
    defer {
      lookup.cancel()
      timeout.cancel()
    }
    var iterator = values.makeAsyncIterator()
    return await iterator.next() ?? .unknown
  }
}
