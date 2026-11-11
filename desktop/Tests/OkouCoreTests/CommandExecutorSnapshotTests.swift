import Foundation
import XCTest

@testable import OkouCore

final class CommandExecutorSnapshotTests: XCTestCase {
  func testCoordinateClickRefreshesAnEvictedSnapshotButRejectsAnExplicitExpiredID() async throws {
    let executor = try makeExecutor()
    let expired = try await captureState(executor, app: "Calculator")
    for _ in 0..<50 { _ = try await captureState(executor, app: "Notes") }

    let explicit = await click(executor, app: "Calculator", snapshotId: expired)
    XCTAssertEqual(explicit["status"].string, "failed")
    XCTAssertEqual(explicit["error"]["code"].string, "invalid_arguments")

    let refreshed = await click(executor, app: "Calculator")
    XCTAssertEqual(refreshed["status"].string, "succeeded")
    let usedSnapshot = try XCTUnwrap(refreshed["result"]["action"]["snapshotId"].string)
    XCTAssertNotEqual(usedSnapshot, expired)
    XCTAssertEqual(refreshed["result"]["action"]["x"].number, 0)
    XCTAssertEqual(refreshed["result"]["action"]["y"].number, 0)
  }

  func testEvictingAnOlderSnapshotPreservesTheSameAppsCurrentSnapshot() async throws {
    let executor = try makeExecutor()
    _ = try await captureState(executor, app: "Calculator")
    let current = try await captureState(executor, app: "Calculator")
    for _ in 0..<49 { _ = try await captureState(executor, app: "Notes") }

    let result = await click(executor, app: "Calculator")
    XCTAssertEqual(result["status"].string, "succeeded")
    XCTAssertEqual(result["result"]["action"]["snapshotId"].string, current)
  }

  private func makeExecutor() throws -> CommandExecutor {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let helper = directory.appendingPathComponent("helper")
    try """
    #!/usr/bin/python3
    import json, sys
    for line in sys.stdin:
        request = json.loads(line)
        kind = request['kind']
        if kind == 'permissions.state':
            result = {'accessibility': True, 'screenRecording': True}
        elif kind == 'app.state':
            result = {'app': request['app'], 'snapshotId': request['snapshotId'],
                      'screenshot': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=',
                      'screenshotSource': 'window', 'screenshotWidth': 1, 'screenshotHeight': 1,
                      'screenshotSourceBounds': {'x': 0, 'y': 0, 'width': 1, 'height': 1},
                      'windowId': 1, 'windowFrame': {'x': 0, 'y': 0, 'width': 1, 'height': 1},
                      'nodeCount': 0, 'elements': []}
        elif kind == 'element.click_point':
            result = {'snapshotId': request['snapshotId'], 'x': request['x'], 'y': request['y']}
        else:
            raise RuntimeError('Unexpected helper operation: ' + kind)
        print(json.dumps({'id': request['id'], 'status': 'succeeded', 'result': result}), flush=True)
    """.write(to: helper, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
    let executor = CommandExecutor(helper: NativeProcess(executable: helper))
    addTeardownBlock {
      await executor.stop()
      try FileManager.default.removeItem(at: directory)
    }
    return executor
  }

  private func captureState(_ executor: CommandExecutor, app: String) async throws -> String {
    let result = await execute(executor, kind: "app.state", payload: ["app": .string(app)])
    XCTAssertEqual(result["status"].string, "succeeded")
    return try XCTUnwrap(result["result"]["snapshotId"].string)
  }

  private func click(
    _ executor: CommandExecutor, app: String, snapshotId: String? = nil
  ) async -> JSONValue {
    var payload: [String: JSONValue] = ["app": .string(app), "x": .number(0), "y": .number(0)]
    if let snapshotId { payload["snapshotId"] = .string(snapshotId) }
    return await execute(executor, kind: "element.click", payload: payload)
  }

  private func execute(
    _ executor: CommandExecutor, kind: String, payload: [String: JSONValue]
  ) async -> JSONValue {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let time = formatter.string(from: Date())
    let command = ComputerUseCommandClaim.Command(
      id: UUID().uuidString, kind: .init(rawValue: kind), status: .running,
      hostId: nil, hostName: nil, payload: .init(additionalFields: payload),
      result: nil, error: nil, timeoutMs: 60_000, createdAt: time, claimedAt: time, completedAt: nil)
    return await executor.execute(command, claimStarted: .now)
  }
}
