import CoreGraphics
import Testing

@testable import ComputerUseHelperCore

struct NativeGeometryTests {
    @Test
    func preservesFiniteGeometryIncludingNegativeScreenPositionsAndEmptyElements() {
        let frames = [
            CGRect(x: -1280.5, y: -20.25, width: 640, height: 480),
            CGRect(x: 100, y: 200, width: 0, height: 0),
        ]
        for frame in frames {
            #expect(validatedNativeFrame(frame) == frame)
        }
    }

    @Test(arguments: [CGFloat.infinity, -CGFloat.infinity, CGFloat.nan])
    func treatsNonFiniteGeometryAsUnavailable(_ value: CGFloat) {
        let frames = [
            CGRect(x: value, y: 20, width: 100, height: 50),
            CGRect(x: 10, y: value, width: 100, height: 50),
            CGRect(x: 10, y: 20, width: value, height: 50),
            CGRect(x: 10, y: 20, width: 100, height: value),
        ]
        for frame in frames {
            #expect(validatedNativeFrame(frame) == nil)
        }
    }

    @Test
    func treatsUnboundedNegativeAndOverflowingFramesAsUnavailable() {
        let largest = CGFloat.greatestFiniteMagnitude
        let frames = [
            CGRect.infinite,
            CGRect.null,
            CGRect(x: 10, y: 20, width: -100, height: 50),
            CGRect(x: 10, y: 20, width: 100, height: -50),
            CGRect(x: largest, y: 20, width: largest, height: 50),
            CGRect(x: 10, y: largest, width: 100, height: largest),
        ]
        for frame in frames {
            #expect(validatedNativeFrame(frame) == nil)
        }
    }
}
