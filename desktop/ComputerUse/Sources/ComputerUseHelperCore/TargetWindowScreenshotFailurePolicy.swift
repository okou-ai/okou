import CoreGraphics

public struct TargetWindowScreenshotFailureTarget: Sendable, Equatable {
    public let pid: Int32
    public let windowNumber: Int
    public let title: String?
    public let onCurrentSpace: Bool?
    public let currentSpaceId: UInt64?
    public let spaceIds: [UInt64]?

    public init(
        pid: Int32,
        windowNumber: Int,
        title: String?,
        onCurrentSpace: Bool?,
        currentSpaceId: UInt64?,
        spaceIds: [UInt64]?
    ) {
        self.pid = pid
        self.windowNumber = windowNumber
        self.title = title
        self.onCurrentSpace = onCurrentSpace
        self.currentSpaceId = currentSpaceId
        self.spaceIds = spaceIds
    }
}

public struct TargetWindowScreenshotFailureRecord: Sendable, Equatable {
    public let ownerPID: Int32?
    public let frame: CGRect?
    public let alpha: Double
    public let isOnScreen: Bool
    public let layer: Int?

    public init(
        ownerPID: Int32?,
        frame: CGRect?,
        alpha: Double,
        isOnScreen: Bool,
        layer: Int?
    ) {
        self.ownerPID = ownerPID
        self.frame = frame
        self.alpha = alpha
        self.isOnScreen = isOnScreen
        self.layer = layer
    }
}

public func targetWindowScreenshotFailureMessage(
    appName: String,
    target: TargetWindowScreenshotFailureTarget,
    record: TargetWindowScreenshotFailureRecord?,
    currentConsoleSessionUnavailable: Bool
) -> String {
    let label = targetWindowScreenshotFailureLabel(appName: appName, target: target)
    let base = "Okou has Screen Recording permission, but macOS could not capture the selected \(label)."
    let retry = "Ask the user to bring that window to the current desktop, keep it visible and unminimized, then retry."

    if currentConsoleSessionUnavailable {
        return "\(base) The Mac appears to be locked or not on the active console. Ask the user to unlock the Mac and retry."
    }

    guard let record else {
        return "\(base) The target window disappeared before capture, likely because the app closed, reopened, or replaced the window. \(retry)"
    }

    if let ownerPID = record.ownerPID, ownerPID != target.pid {
        return "\(base) The target window id now belongs to another process, so the previous window is stale. \(retry)"
    }

    if let freshFrame = record.frame, freshFrame.width <= 0 || freshFrame.height <= 0 {
        return "\(base) macOS reports the target window has no drawable size. \(retry)"
    }

    if record.alpha <= 0.01 {
        return "\(base) macOS reports the target window is hidden or fully transparent. \(retry)"
    }

    if target.onCurrentSpace == false && !record.isOnScreen {
        let currentSpace = target.currentSpaceId.map(String.init) ?? "unknown"
        let windowSpaces = targetWindowScreenshotFailureSpaceIds(target.spaceIds)
        return "\(base) The target window is on another macOS Space (current Space \(currentSpace), window Spaces \(windowSpaces)) and is not visible on screen. \(retry)"
    }

    if !record.isOnScreen {
        return "\(base) macOS reports the target window is not visible on screen, which usually means it is minimized, hidden, offscreen, or on another Space. \(retry)"
    }

    if target.onCurrentSpace == false {
        let currentSpace = target.currentSpaceId.map(String.init) ?? "unknown"
        let windowSpaces = targetWindowScreenshotFailureSpaceIds(target.spaceIds)
        return "\(base) macOS reports the target window is on another Space (current Space \(currentSpace), window Spaces \(windowSpaces)). \(retry)"
    }

    if let layer = record.layer, layer != 0 {
        return "\(base) macOS reports the selected window is not a normal app window layer. \(retry)"
    }

    return "\(base) The window still exists and appears visible, so this is likely a transient WindowServer capture failure or a protected/rapidly changing window. Retry once; if it keeps happening, ask the user to restart Okou Desktop and keep the target window visible."
}

private func targetWindowScreenshotFailureLabel(
    appName: String,
    target: TargetWindowScreenshotFailureTarget
) -> String {
    let title = target.title.map { " \"\($0)\"" } ?? ""
    return "\(appName) window\(title) \(target.windowNumber)"
}

private func targetWindowScreenshotFailureSpaceIds(_ spaceIds: [UInt64]?) -> String {
    guard let spaceIds, !spaceIds.isEmpty else {
        return "unknown"
    }
    return spaceIds.map(String.init).joined(separator: ", ")
}
