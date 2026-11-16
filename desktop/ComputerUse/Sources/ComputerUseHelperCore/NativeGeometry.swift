import CoreGraphics

/// Native accessibility and window APIs can return unavailable, non-finite geometry.
public func validatedNativeFrame(_ frame: CGRect) -> CGRect? {
    guard !frame.isInfinite,
          frame.origin.x.isFinite, frame.origin.y.isFinite,
          frame.size.width.isFinite, frame.size.height.isFinite,
          frame.size.width >= 0, frame.size.height >= 0,
          frame.maxX.isFinite, frame.maxY.isFinite
    else {
        return nil
    }
    return frame
}
