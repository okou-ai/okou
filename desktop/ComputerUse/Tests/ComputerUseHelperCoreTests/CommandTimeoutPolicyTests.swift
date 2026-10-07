import Testing

@testable import ComputerUseHelperCore

struct CommandTimeoutPolicyTests {
    @Test
    func includesCommandKindInFailureMessage() {
        let failure = CommandTimeoutPolicy(timeoutSeconds: 10).failure(kind: "app.state")

        #expect(failure.code == "target_app_unresponsive")
        #expect(failure.message == "Native Computer Use command app.state timed out after 10s; the target app may be unresponsive.")
    }

    @Test
    func handlesMissingCommandKind() {
        let failure = CommandTimeoutPolicy(timeoutSeconds: 2.5).failure(kind: nil)

        #expect(failure.code == "target_app_unresponsive")
        #expect(failure.message == "Native Computer Use command timed out after 2.5s; the target app may be unresponsive.")
    }
}
