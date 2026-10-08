import CoreGraphics

public struct VisualPointerTargetWindow: Sendable {
    public let windowNumber: Int
    public let ownerPID: Int
    public let frame: CGRect

    public init(windowNumber: Int, ownerPID: Int, frame: CGRect) {
        self.windowNumber = windowNumber
        self.ownerPID = ownerPID
        self.frame = frame
    }
}

public struct VisualPointerStackWindow: Sendable {
    public let windowNumber: Int
    public let ownerPID: Int
    public let frame: CGRect
    public let isOnScreen: Bool
    public let alpha: Double

    public init(
        windowNumber: Int,
        ownerPID: Int,
        frame: CGRect,
        isOnScreen: Bool,
        alpha: Double
    ) {
        self.windowNumber = windowNumber
        self.ownerPID = ownerPID
        self.frame = frame
        self.isOnScreen = isOnScreen
        self.alpha = alpha
    }
}

public func topVisibleWindow(
    containing point: CGPoint,
    in windowStack: [VisualPointerStackWindow]
) -> VisualPointerStackWindow? {
    return windowStack.first { window in
        window.isOnScreen &&
            window.alpha > 0.01 &&
            window.frame.width > 0 &&
            window.frame.height > 0 &&
            window.frame.contains(point)
    }
}

public func shouldShowVisualPointer(
    target: VisualPointerTargetWindow,
    point: CGPoint,
    windowStack: [VisualPointerStackWindow]
) -> Bool {
    guard target.frame.contains(point),
          let topWindow = topVisibleWindow(containing: point, in: windowStack)
    else {
        return false
    }

    return topWindow.windowNumber == target.windowNumber ||
        topWindow.ownerPID == target.ownerPID
}

public func isWindowCandidateReachableFromCurrentDisplayContext(
    currentSpaceId: UInt64?,
    windowSpaceIds: [UInt64]?,
    isOnScreen: Bool
) -> Bool {
    guard let currentSpaceId else {
        return isOnScreen
    }

    return windowSpaceIds?.contains(currentSpaceId) == true || isOnScreen
}
