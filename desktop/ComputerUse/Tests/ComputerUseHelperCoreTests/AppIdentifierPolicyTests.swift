import Testing

@testable import ComputerUseHelperCore

struct AppIdentifierPolicyTests {
    private func candidate(
        pid: Int,
        bundleId: String?,
        terminated: Bool = false,
        regular: Bool = true
    ) -> RunningAppCandidate {
        RunningAppCandidate(
            processIdentifier: pid,
            bundleId: bundleId,
            isTerminated: terminated,
            isRegularActivationPolicy: regular
        )
    }

    @Test
    func matchesBundleIdCaseInsensitively() {
        let candidates = [
            candidate(pid: 1, bundleId: "com.apple.Safari"),
            candidate(pid: 2, bundleId: "com.google.Chrome"),
        ]

        let selected = selectRunningApp(bundleId: "COM.GOOGLE.chrome", from: candidates)

        #expect(selected?.processIdentifier == 2)
    }

    @Test
    func trimsSurroundingWhitespace() {
        let candidates = [candidate(pid: 7, bundleId: "com.google.Chrome")]

        let selected = selectRunningApp(bundleId: "  com.google.Chrome\n", from: candidates)

        #expect(selected?.processIdentifier == 7)
    }

    @Test
    func returnsNilForNonBundleIdInput() {
        let candidates = [candidate(pid: 1, bundleId: "com.google.Chrome")]

        #expect(selectRunningApp(bundleId: "Google Chrome", from: candidates) == nil)
    }

    @Test
    func returnsNilForEmptyInput() {
        let candidates = [candidate(pid: 1, bundleId: "com.google.Chrome")]

        #expect(selectRunningApp(bundleId: "   ", from: candidates) == nil)
    }

    @Test
    func ignoresTerminatedInstances() {
        let candidates = [
            candidate(pid: 1, bundleId: "com.google.Chrome", terminated: true),
            candidate(pid: 2, bundleId: "com.google.Chrome", terminated: false),
        ]

        let selected = selectRunningApp(bundleId: "com.google.Chrome", from: candidates)

        #expect(selected?.processIdentifier == 2)
    }

    @Test
    func prefersRegularInstanceWhenBundleIdHasMultipleInstances() {
        let candidates = [
            candidate(pid: 10, bundleId: "com.google.Chrome", regular: false),
            candidate(pid: 11, bundleId: "com.google.Chrome", regular: true),
        ]

        let selected = selectRunningApp(bundleId: "com.google.Chrome", from: candidates)

        #expect(selected?.processIdentifier == 11)
    }

    @Test
    func fallsBackToFirstMatchWhenNoRegularInstance() {
        let candidates = [
            candidate(pid: 20, bundleId: "com.google.Chrome", regular: false),
            candidate(pid: 21, bundleId: "com.google.Chrome", regular: false),
        ]

        let selected = selectRunningApp(bundleId: "com.google.Chrome", from: candidates)

        #expect(selected?.processIdentifier == 20)
    }

    @Test
    func skipsCandidatesWithoutBundleId() {
        let candidates = [
            candidate(pid: 30, bundleId: nil),
            candidate(pid: 31, bundleId: "com.google.Chrome"),
        ]

        let selected = selectRunningApp(bundleId: "com.google.Chrome", from: candidates)

        #expect(selected?.processIdentifier == 31)
    }
}
