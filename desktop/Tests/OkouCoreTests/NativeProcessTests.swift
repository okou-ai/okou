import Foundation
import XCTest

import OkouCore

@MainActor
final class NativeProcessTests: XCTestCase {
  private func fixture(_ source: String) throws -> (CommandExecutor, URL) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("helper")
    try source.write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let helper = NativeProcess(
      executable: executable, environment: ["OKOU_NATIVE_TEST_DIRECTORY": directory.path])
    addTeardownBlock {
      await helper.stop()
      try FileManager.default.removeItem(at: directory)
    }
    return (CommandExecutor(helper: helper), directory)
  }

  private func listApps(_ executor: CommandExecutor) async -> JSONValue {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timestamp = formatter.string(from: Date())
    let command = ComputerUseCommandClaim.Command(
      id: UUID().uuidString, kind: .appsList, status: .running, hostId: "computer", hostName: "Mac",
      payload: [:], result: nil, error: nil, timeoutMs: 5000, createdAt: timestamp,
      claimedAt: timestamp, completedAt: nil)
    return await executor.execute(command, claimStarted: .now)
  }

  func testMalformedResponseReportsSafeDiagnosticsAndRestartsOnlyForANewCommand() async throws {
    let (executor, directory) = try fixture(
      #"""
      #!/usr/bin/python3
      import json, os, pathlib, sys
      root = pathlib.Path(os.environ['OKOU_NATIVE_TEST_DIRECTORY'])
      for line in sys.stdin:
          request = json.loads(line)
          if request['kind'] == 'permissions.state':
              result = {'accessibility': True, 'screenRecording': True}
          else:
              attempts = root / 'attempts'
              first = not attempts.exists()
              with attempts.open('a') as stream:
                  stream.write(str(os.getpid()) + '\n')
              if first:
                  sys.stderr.write('stderr-private-app-content\n' * 16384)
                  sys.stderr.flush()
                  print('stdout-private-app-content', flush=True)
                  continue
              result = {'apps': [{'name': 'Recovered app', 'bundleId': 'test.recovered'}]}
          print(json.dumps({'id': request['id'], 'status': 'succeeded', 'result': result}), flush=True)
      """#)

    let failed = await listApps(executor)
    XCTAssertEqual(failed["status"].string, "failed")
    XCTAssertEqual(failed["error"]["code"].string, "accessibility_unavailable")
    let message = try XCTUnwrap(failed["error"]["message"].string)
    XCTAssertTrue(message.contains("protocol failure: invalid JSON"))
    XCTAssertTrue(message.contains("responseBytes=26"))
    XCTAssertTrue(message.contains("stderrBytes>=65536"))
    XCTAssertTrue(message.contains("do not replay"))
    XCTAssertFalse(failed.formatted.contains("private-app-content"))
    let attempts = directory.appendingPathComponent("attempts")
    let firstDispatch = try String(contentsOf: attempts, encoding: .utf8)
      .split(separator: "\n")
    XCTAssertEqual(firstDispatch.count, 1)

    let recovered = await listApps(executor)
    XCTAssertEqual(recovered["status"].string, "succeeded")
    XCTAssertEqual(recovered["result"]["apps"].array?.first?["bundleId"].string, "test.recovered")
    let allDispatches = try String(contentsOf: attempts, encoding: .utf8)
      .split(separator: "\n")
    XCTAssertEqual(allDispatches.count, 2)
    XCTAssertNotEqual(allDispatches.first, allDispatches.last)
  }

  func testMissingRequestIDRemainsDistinctFromMalformedJSON() async throws {
    let (executor, _) = try fixture(
      #"""
      #!/usr/bin/python3
      import json, sys
      for line in sys.stdin:
          request = json.loads(line)
          if request['kind'] == 'permissions.state':
              response = {'id': request['id'], 'status': 'succeeded',
                          'result': {'accessibility': True, 'screenRecording': True}}
          else:
              response = {'status': 'succeeded', 'result': {'apps': []}}
          print(json.dumps(response), flush=True)
      """#)

    let failed = await listApps(executor)
    XCTAssertEqual(failed["status"].string, "failed")
    XCTAssertEqual(failed["error"]["code"].string, "accessibility_unavailable")
    let message = try XCTUnwrap(failed["error"]["message"].string)
    XCTAssertTrue(message.contains("protocol failure: missing or invalid request ID"))
    XCTAssertTrue(message.contains("stderrBytes=0"))
  }
}
