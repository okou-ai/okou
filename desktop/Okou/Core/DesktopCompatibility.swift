import Foundation

public struct DesktopVersion: Comparable, Sendable {
  private let parts: [UInt64]
  public init?(_ value: String) {
    let components = value.split(separator: ".", omittingEmptySubsequences: false)
    guard components.count == 3,
      components.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) })
    else { return nil }
    let numbers = components.compactMap { UInt64($0) }
    guard numbers.count == 3 else { return nil }
    parts = numbers
  }
  public static func < (lhs: Self, rhs: Self) -> Bool {
    lhs.parts.lexicographicallyPrecedes(rhs.parts)
  }
}

public struct DesktopCompatibility: Sendable {
  public let version: String
  public private(set) var minimumSupportedVersion: String?
  public private(set) var rejected: Bool
  public var required: Bool {
    if rejected { return true }
    guard let minimumSupportedVersion else { return false }
    guard let current = DesktopVersion(version),
      let minimum = DesktopVersion(minimumSupportedVersion)
    else { return true }
    return current < minimum
  }
  public init(version: String, minimumSupportedVersion: String? = nil, rejected: Bool = false) {
    self.version = version
    self.minimumSupportedVersion = minimumSupportedVersion
    self.rejected = rejected
  }
  public mutating func reject(minimum: String?) {
    rejected = true
    if let minimum, DesktopVersion(minimum) != nil { minimumSupportedVersion = minimum }
  }
  public mutating func apply(_ response: APIResponse) throws {
    // Additive rollout: an older API has no policy route. It cannot erase a
    // confirmed rejection/floor. #38098 owns removal after API rollback drains.
    if response.status == 404 { return }
    guard response.status == 200, let object = response.body.object,
      let value = object["minimumSupportedVersion"],
      value == .null || value.string.flatMap(DesktopVersion.init) != nil
    else { throw DesktopFailure("invalid_policy", "Unable to verify Desktop version support") }
    minimumSupportedVersion = value.string
    rejected = false
  }
  public func permitsUpdate(_ version: String) -> Bool {
    guard let candidate = DesktopVersion(version), let current = DesktopVersion(self.version),
      candidate > current
    else { return false }
    guard let minimumSupportedVersion else { return true }
    guard let minimum = DesktopVersion(minimumSupportedVersion) else { return false }
    return candidate >= minimum
  }
}

public enum DesktopUpgradePhase: Equatable, Sendable {
  case checking
  case downloading(Double?)
  case extracting(Double?)
  case draining
  case installing
  case failed(String)
  public var label: String {
    switch self {
    case .checking: "Checking for an update…"
    case .downloading: "Downloading the update…"
    case .extracting: "Preparing the update…"
    case .draining: "Finishing Computer Use and reporting its result…"
    case .installing: "Installing and restarting Okou…"
    case .failed(let message): message
    }
  }
  public var progress: Double? {
    switch self {
    case .downloading(let value), .extracting(let value): value
    default: nil
    }
  }
  public var failed: Bool { if case .failed = self { true } else { false } }
}
