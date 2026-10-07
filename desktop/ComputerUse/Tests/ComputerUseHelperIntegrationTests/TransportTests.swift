import Darwin
import Foundation
import Testing

private final class TransportTestBundle: NSObject {}

private struct TransportTestFailure: Error, CustomStringConvertible {
    let description: String
}

struct TransportTests {
    @Test
    func exitsNormallyAfterStdoutReaderCloses() throws {
        let helper = try HelperProcess(arguments: ["--stdio"])
        defer { helper.stop() }

        let firstResponse = try helper.request([
            "id": "before_stdout_close",
            "kind": "permissions.state",
        ])
        #expect(firstResponse["id"] as? String == "before_stdout_close")
        #expect(firstResponse["status"] as? String == "succeeded")

        helper.closeOutputReader()
        try helper.send([
            "id": "after_stdout_close",
            "kind": "permissions.state",
        ])

        let exited = helper.waitForExit(seconds: 5)
        #expect(exited, "The helper must stop within five seconds of a broken stdout pipe")
        guard exited else {
            return
        }
        #expect(helper.terminationReason == .exit)
        #expect(helper.terminationStatus == 0)
    }

    @Test
    func preservesServeProtocolFailureResponse() throws {
        let helper = try HelperProcess(arguments: ["serve"])
        defer { helper.stop() }

        let response = try helper.request([
            "id": "serve_failure",
            "kind": "unsupported.test",
        ])
        let error = try #require(response["error"] as? [String: Any])
        #expect(response["id"] as? String == "serve_failure")
        #expect(response["status"] as? String == "failed")
        #expect(error["code"] as? String == "unsupported_command")
    }

    @Test
    func preservesOneShotSuccessResponse() throws {
        try expectOneShotResponse(
            request: [
                "id": "oneshot_success",
                "kind": "permissions.state",
            ],
            status: "succeeded"
        )
    }

    @Test
    func preservesOneShotProtocolFailureResponse() throws {
        let response = try expectOneShotResponse(
            request: [
                "id": "oneshot_failure",
                "kind": "unsupported.test",
            ],
            status: "failed"
        )
        let error = try #require(response["error"] as? [String: Any])
        #expect(error["code"] as? String == "unsupported_command")
    }

    @discardableResult
    private func expectOneShotResponse(
        request: [String: Any],
        status: String
    ) throws -> [String: Any] {
        let helper = try HelperProcess(arguments: [])
        defer { helper.stop() }

        try helper.send(request)
        helper.closeInput()
        let response = try helper.readResponse()
        let requestID = try #require(request["id"] as? String)
        #expect(response["id"] as? String == requestID)
        #expect(response["status"] as? String == status)

        let exited = helper.waitForExit(seconds: 5)
        #expect(exited)
        if exited {
            #expect(helper.terminationReason == .exit)
            #expect(helper.terminationStatus == 0)
        }
        return response
    }
}

private final class HelperProcess {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let ended = DispatchSemaphore(value: 0)
    private var pendingOutput = Data()

    init(arguments: [String]) throws {
        let executable = Bundle(for: TransportTestBundle.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("computer-use-helper")
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["OKOU_DESKTOP_SENTRY_DSN"] = ""
        environment["SENTRY_DSN_DESKTOP"] = ""
        process.environment = environment
        let ended = ended
        process.terminationHandler = { _ in ended.signal() }
        try process.run()
        try? input.fileHandleForReading.close()
        try? output.fileHandleForWriting.close()
    }

    var terminationReason: Process.TerminationReason {
        process.terminationReason
    }

    var terminationStatus: Int32 {
        process.terminationStatus
    }

    func request(_ object: [String: Any]) throws -> [String: Any] {
        try send(object)
        return try readResponse()
    }

    func send(_ object: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: object, options: [])
        data.append(10)
        try input.fileHandleForWriting.write(contentsOf: data)
    }

    func readResponse() throws -> [String: Any] {
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        while true {
            if let newline = pendingOutput.firstIndex(of: 10) {
                let line = Data(pendingOutput[..<newline])
                pendingOutput.removeSubrange(...newline)
                guard let response = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                    throw TransportTestFailure(description: "The helper response was not a JSON object")
                }
                return response
            }

            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else {
                throw TransportTestFailure(description: "The helper did not write a JSONL response")
            }
            var descriptor = pollfd(
                fd: output.fileHandleForReading.fileDescriptor,
                events: Int16(POLLIN),
                revents: 0
            )
            let timeoutMilliseconds = Int32(min(remaining * 1_000, Double(Int32.max)))
            let pollResult = poll(&descriptor, 1, timeoutMilliseconds)
            if pollResult < 0, errno == EINTR {
                continue
            }
            guard pollResult > 0 else {
                throw TransportTestFailure(description: "The helper did not write a JSONL response")
            }
            var buffer = [UInt8](repeating: 0, count: 4_096)
            let byteCount = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(descriptor.fd, bytes.baseAddress, bytes.count)
            }
            if byteCount < 0, errno == EINTR {
                continue
            }
            guard byteCount > 0 else {
                throw TransportTestFailure(description: "The helper closed stdout before writing a response")
            }
            pendingOutput.append(contentsOf: buffer.prefix(byteCount))
        }
    }

    func closeInput() {
        try? input.fileHandleForWriting.close()
    }

    func closeOutputReader() {
        try? output.fileHandleForReading.close()
    }

    func waitForExit(seconds: Int) -> Bool {
        ended.wait(timeout: .now() + .seconds(seconds)) == .success
    }

    func stop() {
        closeInput()
        closeOutputReader()
        guard process.isRunning else {
            return
        }
        process.terminate()
        guard ended.wait(timeout: .now() + .seconds(1)) != .success else {
            return
        }
        _ = kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
    }
}
