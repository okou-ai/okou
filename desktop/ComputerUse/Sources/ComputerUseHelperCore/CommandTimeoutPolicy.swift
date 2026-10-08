import Foundation

public struct CommandTimeoutFailure: Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct CommandTimeoutPolicy: Equatable, Sendable {
    public let timeoutSeconds: TimeInterval

    public init(timeoutSeconds: TimeInterval) {
        self.timeoutSeconds = timeoutSeconds
    }

    public static let computerUse = CommandTimeoutPolicy(timeoutSeconds: 10)

    public func failure(kind: String?) -> CommandTimeoutFailure {
        let commandDescription: String
        if let kind, !kind.isEmpty {
            commandDescription = "Native Computer Use command \(kind)"
        } else {
            commandDescription = "Native Computer Use command"
        }
        return CommandTimeoutFailure(
            code: "target_app_unresponsive",
            message: "\(commandDescription) timed out after \(formatTimeout(timeoutSeconds)); the target app may be unresponsive."
        )
    }
}

private func formatTimeout(_ seconds: TimeInterval) -> String {
    if seconds.rounded() == seconds {
        return "\(Int(seconds))s"
    }
    return "\(seconds)s"
}
