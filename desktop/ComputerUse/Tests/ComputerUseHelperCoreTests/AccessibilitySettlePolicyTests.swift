import Foundation
import Testing

@testable import ComputerUseHelperCore

struct AccessibilitySettlePolicyTests {
    private let policy = AccessibilitySettlePolicy(
        requiredStablePasses: 3,
        pollIntervalMicroseconds: 0,
        timeoutSeconds: 1000
    )

    private func node(
        _ id: String,
        role: String? = nil,
        bounds: [String: Double]? = nil,
        name: String? = nil,
        children: [[String: Any]]? = nil
    ) -> [String: Any] {
        var result: [String: Any] = ["id": id]
        if let role { result["role"] = role }
        if let bounds { result["bounds"] = bounds }
        if let name { result["name"] = name }
        if let children { result["children"] = children }
        return result
    }

    @Test
    func stopsAfterRequiredConsecutiveStablePasses() {
        var captureCount = 0
        var sleepCount = 0
        let stable = [node("w0", role: "AXWindow")]

        let result = settleCapture(
            policy: policy,
            now: { 0 },
            sleep: { _ in sleepCount += 1 },
            capture: {
                captureCount += 1
                return stable
            },
            fingerprint: accessibilityElementsFingerprint
        )

        // 1 initial capture + 2 polls to reach 3 consecutive identical passes.
        #expect(captureCount == 3)
        #expect(sleepCount == 2)
        #expect(accessibilityElementsFingerprint(result) == accessibilityElementsFingerprint(stable))
    }

    @Test
    func resetsStableCountWhenFingerprintChanges() {
        let sequence: [[[String: Any]]] = [
            [node("a")],
            [node("a")],
            [node("b")],
            [node("b")],
            [node("b")],
        ]
        var index = 0

        let result = settleCapture(
            policy: policy,
            now: { 0 },
            sleep: { _ in },
            capture: {
                let value = sequence[index]
                index += 1
                return value
            },
            fingerprint: accessibilityElementsFingerprint
        )

        // a, a, b (reset), b, b -> stabilizes only on the trailing run of three.
        #expect(index == 5)
        #expect(accessibilityElementsFingerprint(result) == accessibilityElementsFingerprint([node("b")]))
    }

    @Test
    func stopsAtDeadlineWhenNeverStable() {
        // Alternating fingerprints never stabilize; the deadline must end the loop.
        let unstablePolicy = AccessibilitySettlePolicy(
            requiredStablePasses: 3,
            pollIntervalMicroseconds: 0,
            timeoutSeconds: 2.5
        )
        var clock: TimeInterval = 0
        var captureCount = 0

        let result = settleCapture(
            policy: unstablePolicy,
            now: {
                let value = clock
                clock += 1
                return value
            },
            sleep: { _ in },
            capture: {
                captureCount += 1
                return captureCount.isMultiple(of: 2) ? [node("a")] : [node("b")]
            },
            fingerprint: accessibilityElementsFingerprint
        )

        // deadline = 0 + 2.5; clock yields 0 (deadline), 1, 2 (<2.5), 3 (>=2.5 -> stop).
        #expect(captureCount == 3)
        #expect(accessibilityElementsFingerprint(result) == accessibilityElementsFingerprint([node("b")]))
    }

    @Test
    func fingerprintIsStableForIdenticalStructure() {
        let bounds = ["x": 10.0, "y": 20.0, "width": 100.0, "height": 50.0]
        let first = [node("w0", role: "AXButton", bounds: bounds)]
        let second = [node("w0", role: "AXButton", bounds: bounds)]

        #expect(
            accessibilityElementsFingerprint(first) ==
                accessibilityElementsFingerprint(second)
        )
    }

    @Test
    func fingerprintIgnoresVolatileTextContent() {
        let bounds = ["x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0]
        let labelled = [node("w0", role: "AXStaticText", bounds: bounds, name: "Loading…")]
        let updated = [node("w0", role: "AXStaticText", bounds: bounds, name: "Done")]

        #expect(
            accessibilityElementsFingerprint(labelled) ==
                accessibilityElementsFingerprint(updated)
        )
    }

    @Test
    func fingerprintChangesWhenStructureChanges() {
        let base = [node("w0", role: "AXButton", bounds: ["x": 0, "y": 0, "width": 10, "height": 10])]
        let movedBounds = [node("w0", role: "AXButton", bounds: ["x": 5, "y": 0, "width": 10, "height": 10])]
        let differentRole = [node("w0", role: "AXMenuItem", bounds: ["x": 0, "y": 0, "width": 10, "height": 10])]
        let differentId = [node("w1", role: "AXButton", bounds: ["x": 0, "y": 0, "width": 10, "height": 10])]

        let baseFingerprint = accessibilityElementsFingerprint(base)
        #expect(baseFingerprint != accessibilityElementsFingerprint(movedBounds))
        #expect(baseFingerprint != accessibilityElementsFingerprint(differentRole))
        #expect(baseFingerprint != accessibilityElementsFingerprint(differentId))
    }

    @Test
    func fingerprintIncludesNestedChildren() {
        let parentBounds = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
        let childBounds = ["x": 10.0, "y": 10.0, "width": 20.0, "height": 20.0]
        let withoutChild = [node("w0", role: "AXWindow", bounds: parentBounds)]
        let withChild = [
            node(
                "w0",
                role: "AXWindow",
                bounds: parentBounds,
                children: [node("w0.e0", role: "AXButton", bounds: childBounds)]
            ),
        ]

        #expect(
            accessibilityElementsFingerprint(withoutChild) !=
                accessibilityElementsFingerprint(withChild)
        )
    }
}
