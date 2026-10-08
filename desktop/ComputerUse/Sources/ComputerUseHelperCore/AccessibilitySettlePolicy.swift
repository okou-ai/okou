import Foundation

/// Tuning for the post-action accessibility settle loop.
///
/// Element ids in app-state snapshots are positional tree paths, so a snapshot
/// captured while a menu is still animating open returns ids that shift before
/// the agent can act on them. The settle loop re-captures the tree until its
/// structure fingerprint stops changing, keeping post-action snapshots
/// actionable.
public struct AccessibilitySettlePolicy: Sendable {
    /// Number of consecutive identical fingerprints required to treat the tree
    /// as settled.
    public let requiredStablePasses: Int
    /// Delay between re-capture attempts, in microseconds.
    public let pollIntervalMicroseconds: UInt32
    /// Upper bound on the total time spent waiting for the tree to settle, in
    /// seconds. Reached when the tree never stabilizes (e.g. a perpetually
    /// animating element).
    public let timeoutSeconds: TimeInterval

    public init(
        requiredStablePasses: Int,
        pollIntervalMicroseconds: UInt32,
        timeoutSeconds: TimeInterval
    ) {
        self.requiredStablePasses = requiredStablePasses
        self.pollIntervalMicroseconds = pollIntervalMicroseconds
        self.timeoutSeconds = timeoutSeconds
    }

    /// Defaults applied to snapshots captured immediately after a write action.
    public static let postAction = AccessibilitySettlePolicy(
        requiredStablePasses: 3,
        pollIntervalMicroseconds: 120_000,
        timeoutSeconds: 1.6
    )
}

/// Re-capture a value until its fingerprint stays identical for
/// `policy.requiredStablePasses` consecutive captures, or until the policy
/// timeout elapses. Returns the most recent capture.
///
/// `now`, `sleep`, and `capture` are injected so the control flow can be
/// exercised deterministically in tests without touching the live
/// accessibility tree or the wall clock.
public func settleCapture<T>(
    policy: AccessibilitySettlePolicy,
    now: () -> TimeInterval,
    sleep: (UInt32) -> Void,
    capture: () -> T,
    fingerprint: (T) -> String
) -> T {
    let deadline = now() + policy.timeoutSeconds
    var latest = capture()
    var previousFingerprint = fingerprint(latest)
    var stablePasses = 1
    while stablePasses < policy.requiredStablePasses, now() < deadline {
        sleep(policy.pollIntervalMicroseconds)
        latest = capture()
        let currentFingerprint = fingerprint(latest)
        if currentFingerprint == previousFingerprint {
            stablePasses += 1
        } else {
            stablePasses = 1
            previousFingerprint = currentFingerprint
        }
    }
    return latest
}

/// Append a stable, structure-only fingerprint of a single accessibility node
/// (and its descendants) to `out`. Captures id, role, and integer bounds so
/// that animation-driven positional shifts are detected while ignoring volatile
/// text content.
public func appendAccessibilityFingerprint(
    _ node: [String: Any],
    into out: inout String
) {
    out += (node["id"] as? String) ?? ""
    out += "|"
    out += (node["role"] as? String) ?? ""
    if let bounds = node["bounds"] as? [String: Double] {
        out += "|\(Int(bounds["x"] ?? 0)),\(Int(bounds["y"] ?? 0)),"
        out += "\(Int(bounds["width"] ?? 0)),\(Int(bounds["height"] ?? 0))"
    }
    out += ";"
    if let children = node["children"] as? [[String: Any]] {
        for child in children {
            appendAccessibilityFingerprint(child, into: &out)
        }
    }
}

/// Build a stable, structure-only fingerprint of a captured element list.
public func accessibilityElementsFingerprint(_ elements: [[String: Any]]) -> String {
    var out = ""
    for element in elements {
        appendAccessibilityFingerprint(element, into: &out)
    }
    return out
}
