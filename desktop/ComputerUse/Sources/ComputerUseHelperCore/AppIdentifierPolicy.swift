import Foundation

/// Describes a running application as seen by the helper, reduced to the fields
/// required to select a target by bundle id.
public struct RunningAppCandidate: Sendable, Equatable {
    public let processIdentifier: Int
    public let bundleId: String?
    public let isTerminated: Bool
    public let isRegularActivationPolicy: Bool

    public init(
        processIdentifier: Int,
        bundleId: String?,
        isTerminated: Bool,
        isRegularActivationPolicy: Bool
    ) {
        self.processIdentifier = processIdentifier
        self.bundleId = bundleId
        self.isTerminated = isTerminated
        self.isRegularActivationPolicy = isRegularActivationPolicy
    }
}

/// Selects the running application that matches `bundleId`.
///
/// The `--app` argument accepts a bundle id only. A bundle id is the fixed,
/// locale-independent identifier for an application, unlike the localized name
/// which is presentation-only and can resolve to an arbitrary process. Matching
/// is case-insensitive because Launch Services treats bundle ids that way.
///
/// A single bundle id can still have multiple running instances (e.g. launched
/// with `open -n`). When that happens a regular (UI) instance is preferred over
/// background/agent instances so that a controllable window can be resolved.
public func selectRunningApp(
    bundleId: String,
    from candidates: [RunningAppCandidate]
) -> RunningAppCandidate? {
    let normalized = bundleId
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    guard !normalized.isEmpty else {
        return nil
    }
    let matches = candidates.filter { candidate in
        !candidate.isTerminated && candidate.bundleId?.lowercased() == normalized
    }
    if matches.isEmpty {
        return nil
    }
    return matches.first { candidate in
        candidate.isRegularActivationPolicy
    } ?? matches.first
}
