import CoreGraphics
import Testing

@testable import ComputerUseHelperCore

struct TargetWindowScreenshotFailurePolicyTests {
    private func target(
        pid: Int32 = 100,
        windowNumber: Int = 42,
        title: String? = "Compose",
        onCurrentSpace: Bool? = true,
        currentSpaceId: UInt64? = 7,
        spaceIds: [UInt64]? = [7]
    ) -> TargetWindowScreenshotFailureTarget {
        TargetWindowScreenshotFailureTarget(
            pid: pid,
            windowNumber: windowNumber,
            title: title,
            onCurrentSpace: onCurrentSpace,
            currentSpaceId: currentSpaceId,
            spaceIds: spaceIds
        )
    }

    private func record(
        ownerPID: Int32? = 100,
        frame: CGRect? = CGRect(x: 0, y: 0, width: 400, height: 300),
        alpha: Double = 1,
        isOnScreen: Bool = true,
        layer: Int? = 0
    ) -> TargetWindowScreenshotFailureRecord {
        TargetWindowScreenshotFailureRecord(
            ownerPID: ownerPID,
            frame: frame,
            alpha: alpha,
            isOnScreen: isOnScreen,
            layer: layer
        )
    }

    private func message(
        target: TargetWindowScreenshotFailureTarget? = nil,
        record: TargetWindowScreenshotFailureRecord,
        currentConsoleSessionUnavailable: Bool = false
    ) -> String {
        targetWindowScreenshotFailureMessage(
            appName: "Safari",
            target: target ?? self.target(),
            record: record,
            currentConsoleSessionUnavailable: currentConsoleSessionUnavailable
        )
    }

    @Test
    func includesAppTitleAndWindowNumberInDiagnosticSubject() {
        #expect(message(record: record()).contains("selected Safari window \"Compose\" 42"))
    }

    @Test
    func reportsLockedOrInactiveConsoleBeforeInspectingWindowState() {
        let result = targetWindowScreenshotFailureMessage(
            appName: "Safari",
            target: target(),
            record: nil,
            currentConsoleSessionUnavailable: true
        )

        #expect(result.contains("locked or not on the active console"))
        #expect(result.contains("unlock the Mac and retry"))
    }

    @Test
    func reportsDisappearedWindowWhenWindowServerHasNoRecord() {
        let result = targetWindowScreenshotFailureMessage(
            appName: "Safari",
            target: target(),
            record: nil,
            currentConsoleSessionUnavailable: false
        )

        #expect(result.contains("target window disappeared before capture"))
        #expect(result.contains("app closed, reopened, or replaced the window"))
    }

    @Test
    func reportsStaleWindowWhenOwnerPidChanged() {
        let result = message(record: record(ownerPID: 200))

        #expect(result.contains("window id now belongs to another process"))
        #expect(result.contains("previous window is stale"))
    }

    @Test
    func reportsWindowWithNoDrawableSize() {
        let result = message(record: record(frame: CGRect(x: 0, y: 0, width: 0, height: 300)))

        #expect(result.contains("no drawable size"))
    }

    @Test
    func reportsHiddenOrTransparentWindow() {
        let result = message(record: record(alpha: 0.01))

        #expect(result.contains("hidden or fully transparent"))
    }

    @Test
    func reportsOtherSpaceAndNotVisibleWhenBothSignalsArePresent() {
        let result = message(
            target: target(onCurrentSpace: false, currentSpaceId: 3, spaceIds: [9, 10]),
            record: record(isOnScreen: false)
        )

        #expect(result.contains("on another macOS Space"))
        #expect(result.contains("current Space 3"))
        #expect(result.contains("window Spaces 9, 10"))
        #expect(result.contains("not visible on screen"))
    }

    @Test
    func reportsOffscreenWindowWhenSpaceMetadataDoesNotIdentifyAnotherSpace() {
        let result = message(
            target: target(onCurrentSpace: nil, currentSpaceId: nil, spaceIds: nil),
            record: record(isOnScreen: false)
        )

        #expect(result.contains("not visible on screen"))
        #expect(result.contains("minimized, hidden, offscreen, or on another Space"))
    }

    @Test
    func reportsOtherSpaceWhenWindowIsStillOnScreen() {
        let result = message(
            target: target(onCurrentSpace: false, currentSpaceId: 3, spaceIds: [9]),
            record: record(isOnScreen: true)
        )

        #expect(result.contains("on another Space"))
        #expect(result.contains("current Space 3"))
        #expect(result.contains("window Spaces 9"))
    }

    @Test
    func reportsNonNormalWindowLayer() {
        let result = message(record: record(layer: 27))

        #expect(result.contains("not a normal app window layer"))
    }

    @Test
    func reportsTransientWindowServerFailureWhenWindowAppearsCapturable() {
        let result = message(record: record())

        #expect(result.contains("still exists and appears visible"))
        #expect(result.contains("transient WindowServer capture failure"))
        #expect(result.contains("protected/rapidly changing window"))
    }
}
