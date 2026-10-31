import Darwin
import Foundation
import XCTest

@testable import OkouCore

@MainActor
final class ShellSessionsTests: XCTestCase {
  private let permission = "00000000-0000-4000-8000-000000000001"

  private func request(
    _ owner: ShellSessions, _ kind: String = "shell.cmd", _ payload: [String: JSONValue] = [:]
  ) async -> JSONValue {
    var body = payload
    body["shellPermissionId"] = .string(permission)
    body["waitMs"] = .number(1000)
    do {
      let payload = try JSONDecoder().decode(
        ComputerUseCommandClaim.Command.Payload.self,
        from: JSONEncoder().encode(JSONValue.object(body)))
      return await owner.execute(kind: .init(rawValue: kind), payload: payload, budget: 5)
    } catch {
      XCTFail("Invalid Shell payload: \(error)")
      return .null
    }
  }
  private func fixture(idle: Duration = .seconds(900)) async throws -> (ShellSessions, URL) {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    let owner = ShellSessions(home: home, idleTimeout: idle)
    await owner.configure(permissionId: permission, revision: 0)
    return (owner, home)
  }
  private func physicalPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
  }
  private func output(_ reply: JSONValue) -> String {
    String(
      decoding: Data(base64Encoded: reply["result"]["outputBase64"].string ?? "") ?? Data(),
      as: UTF8.self)
  }
  private func finish(_ owner: ShellSessions, _ initial: JSONValue) async -> JSONValue {
    var reply = initial
    for _ in 0..<10 {
      if reply["result"]["session"]["commandState"].string == "completed" { return reply }
      guard let id = reply["result"]["session"]["id"].string else { return reply }
      reply = await request(owner, "shell.cmd", ["sessionId": .string(id)])
    }
    return reply
  }

  func testPersistentHomeDirectoryEnvironmentAndExitStatus() async throws {
    let (owner, home) = try await fixture()
    defer { try? FileManager.default.removeItem(at: home) }
    try "precmd() { return 0; }\npreexec() { return 0; }\n".write(
      to: home.appendingPathComponent(".zshrc"), atomically: true, encoding: .utf8)
    let first = await finish(
      owner,
      await request(
        owner, "shell.cmd",
        ["command": .string("export OKOU_TEST_VALUE=retained; mkdir child; cd child; false")]))
    XCTAssertEqual(first["status"].string, "succeeded")
    XCTAssertEqual(first["result"]["session"]["initialCwd"].string, home.path)
    XCTAssertEqual(
      first["result"]["session"]["cwd"].string,
      physicalPath(home.appendingPathComponent("child").path))
    XCTAssertEqual(first["result"]["session"]["exitCode"].number, 1)
    let id = try XCTUnwrap(first["result"]["session"]["id"].string)
    let next = await finish(
      owner,
      await request(
        owner, "shell.cmd",
        ["sessionId": .string(id), "command": .string("printf '%s' $OKOU_TEST_VALUE")]))
    XCTAssertTrue(output(next).contains("retained"))
    XCTAssertFalse(output(next).contains("source '"))
    XCTAssertEqual(next["result"]["session"]["exitCode"].number, 0)
    let list = await request(owner, "shell.list")
    XCTAssertEqual(list["result"]["sessions"].array?.count, 1)
    let exited = await request(
      owner, "shell.cmd", ["sessionId": .string(id), "command": .string("exit 7")])
    XCTAssertEqual(exited["result"]["session"]["state"].string, "closed")
    XCTAssertEqual(exited["result"]["session"]["shellExitCode"].number, 7)
    XCTAssertEqual(exited["result"]["session"]["commandState"].string, "unknown")
    await owner.stop()
  }

  func testInteractiveInputAndObservationDoNotReplayOrKillForegroundJob() async throws {
    let (owner, home) = try await fixture()
    defer { try? FileManager.default.removeItem(at: home) }
    let first = await request(
      owner, "shell.cmd", ["command": .string("read -r answer; printf 'answer=%s' $answer")])
    XCTAssertEqual(first["result"]["session"]["commandState"].string, "running")
    let id = try XCTUnwrap(first["result"]["session"]["id"].string)
    let blocked = await request(
      owner, "shell.cmd", ["sessionId": .string(id), "command": .string("echo must-not-run")])
    XCTAssertEqual(blocked["error"]["code"].string, "shell_busy")
    let observed = await request(owner, "shell.cmd", ["sessionId": .string(id)])
    XCTAssertEqual(observed["result"]["session"]["commandState"].string, "running")
    _ = await request(owner, "shell.cmd", ["sessionId": .string(id), "input": .string("hello")])
    let completed = await finish(
      owner, await request(owner, "shell.cmd", ["sessionId": .string(id), "key": .string("Enter")]))
    XCTAssertTrue(output(completed).contains("answer=hello"))
    let sleeping = await request(
      owner, "shell.cmd", ["sessionId": .string(id), "input": .string("sleep 60\n")])
    XCTAssertEqual(sleeping["result"]["session"]["commandState"].string, "running")
    let interrupted = await finish(
      owner,
      await request(owner, "shell.cmd", ["sessionId": .string(id), "key": .string("Ctrl+C")]))
    XCTAssertEqual(interrupted["result"]["session"]["commandState"].string, "completed")
    await owner.stop()
  }

  func testPermissionRotationClosesSessionsAndRejectsQueuedInput() async throws {
    let (owner, home) = try await fixture()
    defer { try? FileManager.default.removeItem(at: home) }
    let first = await request(owner, "shell.cmd", ["command": .string("sleep 60")])
    XCTAssertEqual(first["result"]["session"]["state"].string, "open")
    await owner.configure(permissionId: nil, revision: 1)
    let replacementPermission = UUID().uuidString.lowercased()
    await owner.configure(permissionId: replacementPermission, revision: 2)
    await owner.configure(permissionId: permission, revision: 1)
    let replay = await request(owner, "shell.cmd", ["command": .string("touch should-not-exist")])
    XCTAssertEqual(replay["error"]["code"].string, "permission_denied")
    let count = await owner.count()
    XCTAssertEqual(count, 0)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: home.appendingPathComponent("should-not-exist").path))
    let oldSession = try XCTUnwrap(first["result"]["session"]["id"].string)
    let leaked = await owner.execute(
      kind: .shellStatus,
      payload: .init(sessionId: oldSession, shellPermissionId: replacementPermission), budget: 5)
    XCTAssertEqual(leaked["error"]["code"].string, "shell_unavailable")
    await owner.stop()
  }

  func testSuspendingAJobDoesNotInventACommandExit() async throws {
    let (owner, home) = try await fixture()
    defer { try? FileManager.default.removeItem(at: home) }
    let running = await request(owner, "shell.cmd", ["command": .string("sleep 60")])
    let id = try XCTUnwrap(running["result"]["session"]["id"].string)
    let suspended = await request(
      owner, "shell.cmd", ["sessionId": .string(id), "key": .string("Ctrl+Z")])
    XCTAssertEqual(suspended["result"]["session"]["state"].string, "open")
    XCTAssertEqual(suspended["result"]["session"]["commandState"].string, "unknown")
    XCTAssertEqual(suspended["result"]["session"]["exitCode"], .null)
    await owner.stop()
  }

  func testFailedStartupDoesNotDispatchCommandInput() async throws {
    let (owner, home) = try await fixture()
    defer { try? FileManager.default.removeItem(at: home) }
    try "exit 2\n".write(
      to: home.appendingPathComponent(".zshrc"), atomically: true, encoding: .utf8)
    let failed = await request(owner, "shell.cmd", ["command": .string("touch must-not-run")])
    XCTAssertEqual(failed["error"]["code"].string, "shell_unavailable")
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: home.appendingPathComponent("must-not-run").path))
    await owner.stop()
  }

  func testNestedInteractiveShellCannotReportOuterCommandCompletion() async throws {
    let (owner, home) = try await fixture()
    defer { try? FileManager.default.removeItem(at: home) }
    let nested = await request(owner, "shell.cmd", ["command": .string("/bin/zsh -i")])
    let id = try XCTUnwrap(nested["result"]["session"]["id"].string)
    XCTAssertEqual(nested["result"]["session"]["commandState"].string, "running")
    let childCommand = await request(
      owner, "shell.cmd",
      ["sessionId": .string(id), "input": .string("printf 'child-output\\n'\n")])
    XCTAssertEqual(childCommand["result"]["session"]["commandState"].string, "running")
    let exited = await finish(
      owner,
      await request(owner, "shell.cmd", ["sessionId": .string(id), "input": .string("exit\n")]))
    XCTAssertEqual(exited["result"]["session"]["commandState"].string, "completed")
    await owner.stop()
  }

  func testExecReplacementKeepsInputAvailableWithoutCompletionEvidence() async throws {
    let (owner, home) = try await fixture()
    defer { try? FileManager.default.removeItem(at: home) }
    let replaced = await request(owner, "shell.cmd", ["command": .string("exec /bin/cat")])
    let id = try XCTUnwrap(replaced["result"]["session"]["id"].string)
    XCTAssertEqual(replaced["result"]["session"]["commandState"].string, "unknown")
    let echoed = await request(
      owner, "shell.cmd", ["sessionId": .string(id), "input": .string("exec-input\n")])
    XCTAssertTrue(output(echoed).contains("exec-input"))
    XCTAssertEqual(echoed["result"]["session"]["commandState"].string, "unknown")
    let exited = await request(
      owner, "shell.cmd", ["sessionId": .string(id), "key": .string("Ctrl+D")])
    XCTAssertEqual(exited["result"]["session"]["state"].string, "closed")
    await owner.stop()
  }

  func testShellDispatchDoesNotRequireGUIHelperAndStopRetiresQueuedClaims() async throws {
    let (owner, home) = try await fixture()
    defer { try? FileManager.default.removeItem(at: home) }
    let executor = CommandExecutor(
      helper: NativeProcess(executable: home.appendingPathComponent("missing-gui-helper")),
      shells: owner)
    await executor.configureShell(enabled: true, policyRevision: 1)
    let capabilities = await executor.supportedCapabilities()
    let permission = try XCTUnwrap(capabilities.first { $0.hasPrefix("shell.permission:") })
      .dropFirst("shell.permission:".count)
    let time = "2026-10-15T00:00:00.000Z"
    let claim = ComputerUseCommandClaim.Command(
      id: "operation", kind: .shellCmd, status: .running, hostId: "computer", hostName: "Mac",
      payload: .init(command: "sleep 60", waitMs: 1000, shellPermissionId: String(permission)),
      result: nil, error: nil, timeoutMs: 25000, createdAt: time, claimedAt: time,
      completedAt: nil)
    let first = await executor.execute(claim, claimStarted: .now)
    XCTAssertEqual(first["status"].string, "succeeded")
    XCTAssertEqual(first["result"]["session"]["commandState"].string, "running")
    await executor.retireShellSessions()
    await executor.configureShell(enabled: false, policyRevision: 3)
    await executor.configureShell(enabled: true, policyRevision: 2)
    let advertised = await executor.supportedCapabilities()
    XCTAssertFalse(advertised.contains("shell.cmd"))
    let replay = await executor.execute(claim, claimStarted: .now)
    XCTAssertEqual(replay["error"]["code"].string, "permission_denied")
    let count = await owner.count()
    XCTAssertEqual(count, 0)
    await executor.stop()
  }

  func testBoundedNonConsumingOutputAndIdleExpiry() async throws {
    let (owner, home) = try await fixture(idle: .milliseconds(400))
    defer { try? FileManager.default.removeItem(at: home) }
    let first = await finish(
      owner, await request(owner, "shell.cmd", ["command": .string("yes x | head -c 1200000")]))
    XCTAssertEqual(first["status"].string, "succeeded")
    let id = try XCTUnwrap(first["result"]["session"]["id"].string)
    let a = await request(owner, "shell.cmd", ["sessionId": .string(id), "cursor": .number(0)])
    let b = await request(owner, "shell.cmd", ["sessionId": .string(id), "cursor": .number(0)])
    XCTAssertEqual(a["result"]["outputBase64"], b["result"]["outputBase64"])
    XCTAssertGreaterThan(a["result"]["lostBytes"].number ?? 0, 0)
    XCTAssertLessThanOrEqual(
      Data(base64Encoded: a["result"]["outputBase64"].string ?? "")?.count ?? 0, 32768)
    try await Task.sleep(for: .milliseconds(250))
    _ = await request(owner, "shell.status", ["sessionId": .string(id)])
    try await Task.sleep(for: .milliseconds(200))
    let closed = await request(owner, "shell.status", ["sessionId": .string(id)])
    XCTAssertEqual(closed["result"]["session"]["closeReason"].string, "idle_timeout")
    await owner.stop()
  }
}
