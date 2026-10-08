import CoreGraphics
import Testing

@testable import ComputerUseHelperCore

struct WindowVisibilityPolicyTests {
    private let target = VisualPointerTargetWindow(
        windowNumber: 10,
        ownerPID: 100,
        frame: CGRect(x: 50, y: 50, width: 400, height: 300)
    )

    @Test
    func showsPointerWhenTargetWindowIsTopmostAtPoint() {
        let point = CGPoint(x: 120, y: 140)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func hidesPointerWhenAnotherAppCoversTheTargetPoint() {
        let point = CGPoint(x: 120, y: 140)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 20,
                ownerPID: 200,
                frame: CGRect(x: 100, y: 100, width: 300, height: 200),
                isOnScreen: true,
                alpha: 1
            ),
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(!shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func showsPointerWhenSameAppAuxiliaryWindowCoversTheTargetPoint() {
        let point = CGPoint(x: 120, y: 140)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 11,
                ownerPID: 100,
                frame: CGRect(x: 100, y: 100, width: 300, height: 200),
                isOnScreen: true,
                alpha: 1
            ),
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func ignoresTransparentOrOffscreenCoveringWindows() {
        let point = CGPoint(x: 120, y: 140)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 20,
                ownerPID: 200,
                frame: CGRect(x: 100, y: 100, width: 300, height: 200),
                isOnScreen: true,
                alpha: 0
            ),
            VisualPointerStackWindow(
                windowNumber: 21,
                ownerPID: 201,
                frame: CGRect(x: 100, y: 100, width: 300, height: 200),
                isOnScreen: false,
                alpha: 1
            ),
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func hidesPointerWhenPointIsOutsideTargetFrame() {
        let point = CGPoint(x: 500, y: 500)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(!shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func treatsVisibleWindowsOnAnotherDisplayAsReachable() {
        #expect(
            isWindowCandidateReachableFromCurrentDisplayContext(
                currentSpaceId: 1,
                windowSpaceIds: [2],
                isOnScreen: true
            )
        )
    }

    @Test
    func rejectsOffscreenWindowsOnAnotherSpace() {
        #expect(
            !isWindowCandidateReachableFromCurrentDisplayContext(
                currentSpaceId: 1,
                windowSpaceIds: [2],
                isOnScreen: false
            )
        )
    }

    @Test
    func acceptsWindowsOnTheCurrentSpaceEvenWithoutOnscreenMetadata() {
        #expect(
            isWindowCandidateReachableFromCurrentDisplayContext(
                currentSpaceId: 1,
                windowSpaceIds: [1],
                isOnScreen: false
            )
        )
    }
}
