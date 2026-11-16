import Darwin
import Foundation
import OkouCore
import XCTest

@MainActor
final class NativeProcessTests: XCTestCase {
  private func telemetry() throws -> SentryHTTPCollector {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    return collector
  }

  private func nativeFixture(
    _ source: String, purpose: NativeProcess.Purpose = .computerUse,
    now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
    awakeNow: @escaping @Sendable () -> SuspendingClock.Instant = { .now }
  ) throws -> (NativeProcess, URL) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("helper")
    try source.write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let helper = NativeProcess(
      executable: executable, environment: ["OKOU_NATIVE_TEST_DIRECTORY": directory.path],
      purpose: purpose, now: now, awakeNow: awakeNow)
    addTeardownBlock {
      await helper.stop()
      try FileManager.default.removeItem(at: directory)
    }
    return (helper, directory)
  }

  private func fixture(_ source: String) throws -> (CommandExecutor, URL) {
    let (helper, directory) = try nativeFixture(source)
    return (CommandExecutor(helper: helper), directory)
  }

  private func permissionFixture(
    awakeAdvance: Duration = .milliseconds(200), responds: Bool = true,
    requestsBeforeSuspension: Int = 1
  ) throws -> (helper: NativeProcess, directory: URL, marker: URL) {
    let marker = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: marker) }
    let awakeStarted = SuspendingClock.now
    let (helper, directory) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import json, os, pathlib, sys, tempfile
      root = pathlib.Path(os.environ['OKOU_NATIVE_TEST_DIRECTORY'])
      marker = pathlib.Path(tempfile.gettempdir()) / "\#(marker.lastPathComponent)"
      first_request = None
      for line in sys.stdin:
          request = json.loads(line)
          if first_request is None:
              first_request = request
          with (root / 'attempts').open('a') as stream:
              stream.write(request['kind'] + '\n')
          if len((root / 'attempts').read_text().splitlines()) >= \#(requestsBeforeSuspension):
              marker.write_text(str(os.getpid()))
              if \#(responds ? "True" : "False"):
                  print(json.dumps({'id': first_request['id'], 'status': 'succeeded',
                                    'result': {'accessibility': True, 'screenRecording': True,
                                               'pid': os.getpid()}}), flush=True)
      """#,
      now: {
        ContinuousClock.now.advanced(
          by: .seconds(FileManager.default.fileExists(atPath: marker.path) ? 120 : 0))
      },
      awakeNow: {
        FileManager.default.fileExists(atPath: marker.path)
          ? awakeStarted.advanced(by: awakeAdvance) : awakeStarted
      })
    return (helper, directory, marker)
  }

  private func listApps(_ executor: CommandExecutor, timeoutMs: Int = 5000) async -> JSONValue {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timestamp = formatter.string(from: Date())
    let command = ComputerUseCommandClaim.Command(
      id: UUID().uuidString, kind: .appsList, status: .running, hostId: "computer", hostName: "Mac",
      payload: .init(), result: nil, error: nil, timeoutMs: timeoutMs, createdAt: timestamp,
      claimedAt: timestamp, completedAt: nil)
    return await executor.execute(command, claimStarted: .now)
  }

  func testMalformedResponseReportsSafeDiagnosticsAndRestartsOnlyForANewCommand() async throws {
    let collector = try telemetry()
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
    let events = try collector.events()
    XCTAssertEqual(events.count, 1)
    let event = try XCTUnwrap(events.first)
    XCTAssertEqual(event["release"].string, "okou-desktop@0.54.1")
    XCTAssertEqual(event["environment"].string, "integration-test")
    XCTAssertEqual(event["tags"]["component"].string, "desktop-main")
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "invalid_json")
    XCTAssertEqual(event["contexts"]["nativeHelper"]["responseBytes"].number, 26)
    XCTAssertEqual(event["contexts"]["nativeHelper"]["stderrBytes"].number, 65_536)
    XCTAssertFalse(event.formatted.contains("private-app-content"))
    let attachments = try collector.attachments(for: event)
    XCTAssertEqual(
      attachments["native-helper-response.bin"], Data("stdout-private-app-content".utf8))
    let details = String(
      decoding: try XCTUnwrap(attachments["native-helper-diagnostics.txt"]), as: UTF8.self)
    XCTAssertTrue(details.contains("failure=invalid_json"))
    XCTAssertTrue(details.contains("decoderError="))

    DesktopTelemetry.captureStartupFailure()
    let startup = try XCTUnwrap(
      collector.events().first { $0["event_id"] != event["event_id"] })
    XCTAssertTrue(try collector.attachments(for: startup).isEmpty)
  }

  func testMissingRequestIDRemainsDistinctFromMalformedJSON() async throws {
    let collector = try telemetry()
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
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "missing_request_id")
    let attachments = try collector.attachments(for: event)
    let raw = try XCTUnwrap(attachments["native-helper-response.bin"])
    let response = try JSONDecoder().decode(JSONValue.self, from: raw)
    XCTAssertEqual(response["status"].string, "succeeded")
    XCTAssertEqual(response["result"]["apps"].array, [])
  }

  func testLargeMalformedResponsePreservesBinaryBytesInTheSentryAttachment() async throws {
    let collector = try telemetry()
    let (executor, directory) = try fixture(
      #"""
      #!/usr/bin/python3
      import json, os, pathlib, sys
      root = pathlib.Path(os.environ['OKOU_NATIVE_TEST_DIRECTORY'])
      for line in sys.stdin:
          request = json.loads(line)
          if request['kind'] == 'permissions.state':
              print(json.dumps({'id': request['id'], 'status': 'succeeded',
                                'result': {'accessibility': True, 'screenRecording': True}}), flush=True)
          else:
              payload = (b'{"id":' + str(request['id']).encode() +
                         b',"status":"succeeded","result":{"content":"' +
                         (b'0123456789abcdefghijklmnopqrstuvwxyz' * 44738)[:1610565] + b'\xff"}')
              (root / 'malformed-response.bin').write_bytes(payload)
              sys.stdout.buffer.write(payload + b'\n')
              sys.stdout.buffer.flush()
      """#)

    let failed = await listApps(executor)
    XCTAssertEqual(failed["status"].string, "failed")
    XCTAssertEqual(failed["error"]["code"].string, "accessibility_unavailable")
    XCTAssertTrue(failed["error"]["message"].string?.contains("protocol failure: invalid JSON") == true)
    await fulfillment(of: [collector.expectation(eventCount: 1)], timeout: 5)
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "invalid_json")
    let attachments = try collector.attachments(for: event)
    let expected = try Data(contentsOf: directory.appendingPathComponent("malformed-response.bin"))
    let received = try XCTUnwrap(attachments["native-helper-response.bin"])
    XCTAssertFalse(event.formatted.contains("0123456789abcdefghijklmnopqrstuvwxyz"))
    let details = String(
      decoding: try XCTUnwrap(attachments["native-helper-diagnostics.txt"]), as: UTF8.self)
    let mismatch = zip(received, expected).enumerated().first { $0.element.0 != $0.element.1 }?
      .offset
    XCTAssertEqual(
      received, expected, "firstMismatchOffset=\(String(describing: mismatch))\n\(details)")
    XCTAssertTrue(details.contains("responseBytes=\(expected.count)"))
    XCTAssertTrue(details.contains("responseTruncated=false"))
    XCTAssertTrue(details.contains("DecodingError"))
  }

  func testOversizedOutputIsRetiredBeforeDecoding() async throws {
    let collector = try telemetry()
    let (executor, _) = try fixture(
      #"""
      #!/usr/bin/python3
      import json, sys
      for line in sys.stdin:
          request = json.loads(line)
          if request['kind'] == 'permissions.state':
              print(json.dumps({'id': request['id'], 'status': 'succeeded',
                                'result': {'accessibility': True, 'screenRecording': True}}), flush=True)
          else:
              sys.stdout.buffer.write(b'x' * (33 * 1024 * 1024) + b'\n')
              sys.stdout.buffer.flush()
      """#)

    let failed = await listApps(executor, timeoutMs: 30_000)
    XCTAssertEqual(failed["error"]["code"].string, "result_too_large")
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "response_limit")
    XCTAssertTrue(try collector.attachments(for: event).isEmpty)
  }

  func testCoalescedResponsesKeepSuccessfulContentOutOfTheFailureAttachment() async throws {
    let collector = try telemetry()
    let (helper, _) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import json, sys
      requests = [json.loads(sys.stdin.readline()), json.loads(sys.stdin.readline())]
      good = next(request for request in requests if request['kind'] == 'first')
      content = ('0123456789abcdefghijklmnopqrstuvwxyz' * 44738)[:1610565]
      response = {'id': good['id'], 'status': 'succeeded', 'result': {'content': content}}
      sys.stdout.buffer.write(json.dumps(response).encode() + b'\n' + b'invalid-second-response\n')
      sys.stdout.buffer.flush()
      for line in sys.stdin:
          pass
      """#)

    async let good = helper.request(.object(["kind": .string("first")]))
    async let bad = helper.request(.object(["kind": .string("second")]))
    let succeeded = try await good
    XCTAssertEqual(succeeded["status"].string, "succeeded")
    let expected = String(
      String(repeating: "0123456789abcdefghijklmnopqrstuvwxyz", count: 44738).prefix(1_610_565))
    XCTAssertEqual(succeeded["result"]["content"].string, expected)
    do {
      _ = try await bad
      XCTFail("The malformed second response must fail its pending request")
    } catch let failure as DesktopFailure {
      XCTAssertEqual(failure.code, "accessibility_unavailable")
    }
    let events = try collector.events()
    XCTAssertEqual(events.count, 1)
    let event = try XCTUnwrap(events.first)
    let attachments = try collector.attachments(for: event)
    XCTAssertEqual(attachments["native-helper-response.bin"], Data("invalid-second-response".utf8))
  }

  func testExitStatusDistinguishesExitCodesFromSignals() async throws {
    let collector = try telemetry()
    let cases: [(String, String, NativeProcess.Purpose)] = [
      ("os._exit(15)", "exit", .computerUse),
      ("os.kill(os.getpid(), signal.SIGTERM)", "uncaught_signal", .browserAutomationProbe),
    ]
    for (terminate, reason, purpose) in cases {
      let (helper, _) = try nativeFixture(
        """
        #!/usr/bin/python3
        import os, signal, sys
        for line in sys.stdin:
            \(terminate)
        """, purpose: purpose)
      let response = await listApps(CommandExecutor(helper: helper))
      XCTAssertEqual(response["error"]["code"].string, "accessibility_unavailable")
      let event = try XCTUnwrap(
        collector.events().first {
          $0["contexts"]["nativeHelper"]["purpose"].string == purpose.rawValue
        })
      let diagnostics = event["contexts"]["nativeHelper"]
      XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "unexpected_exit")
      XCTAssertEqual(diagnostics["exitStatus"].number, 15)
      XCTAssertEqual(diagnostics["terminationReason"].string, reason)
      XCTAssertEqual(diagnostics["generation"].number, 1)
      XCTAssertEqual(diagnostics["pendingRequests"].number, 1)
    }
    XCTAssertEqual(try collector.events().count, 2)
  }

  func testHelperTimeoutIsDeliveredToSentry() async throws {
    let collector = try telemetry()
    let (helper, _) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import sys
      for line in sys.stdin:
          pass
      """#)
    for kind in ["apps.list", "private-operation-content"] {
      do {
        _ = try await helper.request(
          .object(["kind": .string(kind), "text": .string("private-input-content")]), timeout: 0.1)
        XCTFail("An unanswered helper request must fail at its deadline")
      } catch let failure as DesktopFailure {
        XCTAssertEqual(failure.code, "command_timeout")
      }
    }
    let events = try collector.events()
    XCTAssertEqual(events.count, 2)
    for (operation, generation) in [("apps.list", 1), ("unknown", 3)] {
      let event = try XCTUnwrap(
        events.first { $0["contexts"]["nativeHelper"]["generation"].number == Double(generation) })
      let diagnostics = event["contexts"]["nativeHelper"]
      XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "timeout")
      XCTAssertEqual(diagnostics["purpose"].string, "computer_use")
      XCTAssertEqual(diagnostics["operation"].string, operation)
      XCTAssertEqual(diagnostics["timeoutMs"].number, 100)
      XCTAssertGreaterThanOrEqual(try XCTUnwrap(diagnostics["elapsedMs"].number), 100)
      XCTAssertGreaterThanOrEqual(try XCTUnwrap(diagnostics["awakeElapsedMs"].number), 0)
      XCTAssertFalse(event.formatted.contains("private-operation-content"))
      XCTAssertFalse(event.formatted.contains("private-input-content"))
    }
  }

  func testSuspendedPermissionRefreshReturnsNoStateAndRecoversOnlyForTheNextRefresh() async throws {
    let collector = try telemetry()
    let fixture = try permissionFixture()
    let executor = CommandExecutor(helper: fixture.helper)

    let interrupted = try await executor.permissions()
    XCTAssertNil(interrupted)
    let retiredPID = try XCTUnwrap(
      Int32(String(contentsOf: fixture.marker, encoding: .utf8)))
    XCTAssertEqual(kill(retiredPID, 0), -1)
    XCTAssertEqual(errno, ESRCH)
    let firstAttempts = try String(
      contentsOf: fixture.directory.appendingPathComponent("attempts"), encoding: .utf8)
    XCTAssertEqual(firstAttempts.split(separator: "\n"), ["permissions.state"])

    let refreshed = try await executor.permissions()
    let state = try XCTUnwrap(refreshed)
    XCTAssertEqual(state["accessibility"].bool, true)
    XCTAssertEqual(state["screenRecording"].bool, true)
    XCTAssertNotEqual(state["pid"].number, Double(retiredPID))
    let attempts = try String(
      contentsOf: fixture.directory.appendingPathComponent("attempts"), encoding: .utf8)
    XCTAssertEqual(attempts.split(separator: "\n"), ["permissions.state", "permissions.state"])

    let events = try collector.events()
    XCTAssertEqual(events.count, 1)
    let event = try XCTUnwrap(events.first)
    XCTAssertEqual(event["level"].string, "info")
    XCTAssertEqual(
      event["fingerprint"],
      .array([.string("desktop-native-helper"), .string("permission-check-system-suspension")]))
    let diagnostics = event["contexts"]["nativeHelper"]
    XCTAssertEqual(diagnostics["requestIntent"].string, "permission_refresh")
    XCTAssertEqual(diagnostics["outcome"].string, "expired_during_system_suspension")
    XCTAssertEqual(diagnostics["timeoutMs"].number, 10000)
    XCTAssertLessThan(try XCTUnwrap(diagnostics["awakeElapsedMs"].number), 10000)
    XCTAssertGreaterThan(try XCTUnwrap(diagnostics["systemSuspendedMs"].number), 100000)
  }

  func testSuspendedPermissionRefreshTimerStillReturnsTheFailedDeadlineOutcome() async throws {
    let collector = try telemetry()
    let fixture = try permissionFixture(responds: false)
    do {
      _ = try await fixture.helper.request(
        .object(["kind": .string("permissions.state")]), timeout: 1, intent: .permissionRefresh)
      XCTFail("A suspended permission request must still expire")
    } catch let failure as DesktopFailure {
      XCTAssertEqual(failure.code, "command_timeout")
      XCTAssertEqual(failure.response["status"].string, "failed")
      XCTAssertEqual(failure.interruption, .suspendedPermissionRefresh)
    }
    let retiredPID = try XCTUnwrap(
      Int32(String(contentsOf: fixture.marker, encoding: .utf8)))
    XCTAssertEqual(kill(retiredPID, 0), -1)
    XCTAssertEqual(errno, ESRCH)
    await fulfillment(of: [collector.expectation(eventCount: 1)], timeout: 5)
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["level"].string, "info")
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "timeout")
    XCTAssertEqual(event["contexts"]["nativeHelper"]["requestIntent"].string, "permission_refresh")
    XCTAssertEqual(
      event["contexts"]["nativeHelper"]["outcome"].string, "expired_during_system_suspension")
  }

  func testAwakePermissionRefreshTimeoutStillPropagatesAnError() async throws {
    let collector = try telemetry()
    let fixture = try permissionFixture(awakeAdvance: .seconds(11))
    let executor = CommandExecutor(helper: fixture.helper)
    do {
      _ = try await executor.permissions()
      XCTFail("A genuinely awake overrun must remain a failure")
    } catch let failure as DesktopFailure {
      XCTAssertEqual(failure.code, "command_timeout")
      XCTAssertNil(failure.interruption)
    }
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["level"].string, "error")
    XCTAssertEqual(event["contexts"]["nativeHelper"]["requestIntent"].string, "permission_refresh")
  }

  func testSuspendedCommandPreflightStillFailsBeforeDispatchingTheCommand() async throws {
    let collector = try telemetry()
    let fixture = try permissionFixture()
    let result = await listApps(CommandExecutor(helper: fixture.helper))
    XCTAssertEqual(result["status"].string, "failed")
    XCTAssertEqual(result["error"]["code"].string, "command_timeout")
    XCTAssertTrue(try XCTUnwrap(result["error"]["message"].string).contains("asleep"))
    let attempts = try String(
      contentsOf: fixture.directory.appendingPathComponent("attempts"), encoding: .utf8)
    XCTAssertEqual(attempts.split(separator: "\n"), ["permissions.state"])
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["level"].string, "info")
    XCTAssertEqual(event["contexts"]["nativeHelper"]["requestIntent"].string, "command_preflight")
    XCTAssertEqual(
      event["contexts"]["nativeHelper"]["outcome"].string, "expired_during_system_suspension")
    XCTAssertEqual(
      event["fingerprint"],
      .array([.string("desktop-native-helper"), .string("permission-check-system-suspension")]))
  }

  func testSuspendedPermissionReadWithUnspecifiedIntentRemainsAnError() async throws {
    let collector = try telemetry()
    let fixture = try permissionFixture()
    do {
      _ = try await fixture.helper.request(.object(["kind": .string("permissions.state")]))
      XCTFail("An unowned suspended read must remain a failure")
    } catch let failure as DesktopFailure {
      XCTAssertEqual(failure.code, "command_timeout")
      XCTAssertNil(failure.interruption)
    }
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["level"].string, "error")
    XCTAssertEqual(event["contexts"]["nativeHelper"]["requestIntent"].string, "unspecified")
  }

  func testSuspendedPermissionRefreshDoesNotHideAnotherPendingRequest() async throws {
    let collector = try telemetry()
    let fixture = try permissionFixture(requestsBeforeSuspension: 2)
    let first = Task {
      try await fixture.helper.request(
        .object(["kind": .string("permissions.state")]), intent: .permissionRefresh)
    }
    let attemptsURL = fixture.directory.appendingPathComponent("attempts")
    let received = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in FileManager.default.fileExists(atPath: attemptsURL.path) },
      object: nil)
    await fulfillment(of: [received], timeout: 5)
    let second = Task {
      try await fixture.helper.request(
        .object(["kind": .string("keyboard.type_text"), "text": .string("test-input")]))
    }
    for result in [await first.result, await second.result] {
      switch result {
      case .success: XCTFail("Retiring this generation must fail both pending requests")
      case .failure(let error):
        let failure = try XCTUnwrap(error as? DesktopFailure)
        XCTAssertEqual(failure.code, "command_timeout")
        XCTAssertNil(failure.interruption)
      }
    }
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["level"].string, "error")
    XCTAssertEqual(event["contexts"]["nativeHelper"]["pendingRequests"].number, 2)
    XCTAssertEqual(event["contexts"]["nativeHelper"]["operation"].string, "permissions.state")
  }

  func testBlockedStdinWriteExpiresAndReapsTheHelperBeforeRecovery() async throws {
    let collector = try telemetry()
    let (helper, directory) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import json, os, pathlib, signal, sys
      root = pathlib.Path(os.environ['OKOU_NATIVE_TEST_DIRECTORY'])
      first = not (root / 'blocked').exists()
      for line in sys.stdin:
          request = json.loads(line)
          with (root / 'attempts').open('a') as stream:
              stream.write(request['kind'] + '\n')
          print(json.dumps({'id': request['id'], 'status': 'succeeded',
                            'result': {'pid': os.getpid()}}), flush=True)
          if first:
              (root / 'blocked').touch()
              signal.pause()
      """#)
    let ready = try await helper.request(.object(["kind": .string("ready")]))
    let retiredPID = try XCTUnwrap(ready["result"]["pid"].number.flatMap(Int32.init(exactly:)))
    do {
      _ = try await helper.request(
        .object([
          "kind": .string("keyboard.type_text"),
          "text": .string(String(repeating: "x", count: 1_048_576)),
        ]), timeout: 0.2)
      XCTFail("A helper that stops reading stdin must still be retired at the deadline")
    } catch let failure as DesktopFailure {
      XCTAssertEqual(failure.code, "command_timeout")
      XCTAssertTrue(failure.message.contains("do not replay"))
    }
    XCTAssertEqual(kill(retiredPID, 0), -1)
    XCTAssertEqual(errno, ESRCH)
    let recovered = try await helper.request(.object(["kind": .string("recovery")]))
    XCTAssertNotEqual(recovered["result"]["pid"], ready["result"]["pid"])
    let attempts = try String(
      contentsOf: directory.appendingPathComponent("attempts"), encoding: .utf8)
    XCTAssertEqual(attempts.split(separator: "\n"), ["ready", "recovery"])
    let events = try collector.events()
    XCTAssertEqual(events.count, 1)
    let event = try XCTUnwrap(events.first)
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "timeout")
    XCTAssertEqual(event["contexts"]["nativeHelper"]["operation"].string, "keyboard.type_text")
  }

  func testReadyResponseCannotSucceedAfterDeadlineAndOnlyANewCommandRestartsHelper() async throws {
    let collector = try telemetry()
    let marker = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    addTeardownBlock { try FileManager.default.removeItem(at: marker) }
    let started = ContinuousClock.now
    let awakeStarted = SuspendingClock.now
    let (helper, directory) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import json, os, pathlib, sys
      root = pathlib.Path(os.environ['OKOU_NATIVE_TEST_DIRECTORY'])
      for line in sys.stdin:
          request = json.loads(line)
          with (root / 'attempts').open('a') as stream:
              stream.write(request['kind'] + '\n')
          if request['kind'] == 'keyboard.type_text':
              pathlib.Path(request['marker']).write_text(str(os.getpid()))
          print(json.dumps({'id': request['id'], 'status': 'succeeded',
                            'result': {'pid': os.getpid()}}), flush=True)
      """#,
      now: {
        // Advance the OS clock boundary only after the helper handles the input.
        started.advanced(
          by: .seconds(FileManager.default.fileExists(atPath: marker.path) ? 31 : 0))
      },
      awakeNow: {
        // Model 30 seconds of system sleep plus one awake second at the clock boundary.
        awakeStarted.advanced(
          by: .seconds(FileManager.default.fileExists(atPath: marker.path) ? 1 : 0))
      })

    do {
      _ = try await helper.request(
        .object([
          "kind": .string("keyboard.type_text"), "text": .string("private-input-content"),
          "marker": .string(marker.path),
        ]), timeout: 30)
      XCTFail("A response processed after the deadline must fail even before the timer runs")
    } catch let failure as DesktopFailure {
      XCTAssertEqual(failure.code, "command_timeout")
      XCTAssertTrue(failure.message.contains("do not replay"))
    }
    let retiredPID = try XCTUnwrap(
      Int32(String(contentsOf: marker, encoding: .utf8)))
    XCTAssertEqual(kill(retiredPID, 0), -1)
    XCTAssertEqual(errno, ESRCH)
    let response = try await helper.request(.object(["kind": .string("apps.list")]))
    XCTAssertEqual(response["status"].string, "succeeded")
    XCTAssertNotEqual(response["result"]["pid"].number, Double(retiredPID))
    let attempts = try String(
      contentsOf: directory.appendingPathComponent("attempts"), encoding: .utf8)
    XCTAssertEqual(attempts.split(separator: "\n"), ["keyboard.type_text", "apps.list"])

    let events = try collector.events()
    XCTAssertEqual(events.count, 1)
    let event = try XCTUnwrap(events.first)
    let diagnostics = event["contexts"]["nativeHelper"]
    XCTAssertEqual(diagnostics["operation"].string, "keyboard.type_text")
    XCTAssertEqual(event["level"].string, "error")
    XCTAssertEqual(diagnostics["timeoutMs"].number, 30000)
    XCTAssertEqual(diagnostics["elapsedMs"].number, 31000)
    XCTAssertEqual(diagnostics["awakeElapsedMs"].number, 1000)
    XCTAssertEqual(diagnostics["systemSuspendedMs"].number, 30000)
    XCTAssertFalse(event.formatted.contains("private-input-content"))
    XCTAssertFalse(event.formatted.contains(marker.path))
    XCTAssertTrue(try collector.attachments(for: event).isEmpty)
  }

  func testExplicitStopReapsTheHelperWithoutReportingAnUnexpectedExit() async throws {
    let collector = try telemetry()
    let (helper, directory) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import json, os, pathlib, sys
      attempts = pathlib.Path(os.environ['OKOU_NATIVE_TEST_DIRECTORY']) / 'attempts'
      for line in sys.stdin:
          request = json.loads(line)
          with attempts.open('a') as stream:
              stream.write(request['kind'] + '\n')
          if request['kind'] == 'exit':
              os._exit(15)
          print(json.dumps({'id': request['id'], 'status': 'succeeded',
                            'result': {'pid': os.getpid()}}), flush=True)
      """#)

    let first = try await helper.request(.object(["kind": .string("first")]))
    let retiredPID = try XCTUnwrap(first["result"]["pid"].number.flatMap(Int32.init(exactly:)))
    await helper.stop()
    XCTAssertEqual(kill(retiredPID, 0), -1)
    XCTAssertEqual(errno, ESRCH)

    let second = try await helper.request(.object(["kind": .string("second")]))
    XCTAssertNotEqual(first["result"]["pid"], second["result"]["pid"])
    do {
      _ = try await helper.request(.object(["kind": .string("exit")]))
      XCTFail("The replacement helper's exit must fail its pending request")
    } catch let failure as DesktopFailure {
      XCTAssertEqual(failure.code, "accessibility_unavailable")
    }
    let events = try collector.events()
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?["contexts"]["nativeHelper"]["generation"].number, 3)
    XCTAssertEqual(events.first?["contexts"]["nativeHelper"]["terminationReason"].string, "exit")
    let attempts = try String(
      contentsOf: directory.appendingPathComponent("attempts"), encoding: .utf8)
    XCTAssertEqual(attempts.split(separator: "\n"), ["first", "second", "exit"])
  }

  func testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath() async throws {
    let collector = try telemetry()
    let helper = NativeProcess(
      executable: URL(fileURLWithPath: "/nonexistent/private-helper-installation/helper"))
    let executor = CommandExecutor(helper: helper)
    let response = await listApps(executor)
    XCTAssertEqual(response["status"].string, "failed")
    await fulfillment(of: [collector.expectation(eventCount: 1)], timeout: 5)
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "launch_failed")
    XCTAssertFalse(event.formatted.contains("private-helper-installation"))
  }

  func testHelperLaunchDeliveryProbe001() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe002() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe003() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe004() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe005() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe006() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe007() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe008() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe009() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe010() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe011() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe012() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe013() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe014() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe015() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe016() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe017() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe018() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe019() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe020() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe021() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe022() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe023() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe024() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe025() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe026() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe027() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe028() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe029() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe030() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe031() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe032() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe033() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe034() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe035() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe036() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe037() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe038() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe039() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe040() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe041() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe042() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe043() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe044() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe045() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe046() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe047() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe048() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe049() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe050() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe051() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe052() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe053() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe054() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe055() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe056() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe057() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe058() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe059() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe060() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe061() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe062() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe063() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe064() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe065() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe066() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe067() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe068() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe069() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe070() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe071() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe072() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe073() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe074() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe075() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe076() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe077() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe078() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe079() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe080() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe081() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe082() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe083() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe084() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe085() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe086() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe087() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe088() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe089() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe090() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe091() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe092() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe093() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe094() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe095() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe096() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe097() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe098() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe099() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe100() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe101() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe102() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe103() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe104() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe105() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe106() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe107() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe108() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe109() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe110() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe111() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe112() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe113() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe114() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe115() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe116() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe117() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe118() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe119() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe120() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe121() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe122() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe123() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe124() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe125() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe126() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe127() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe128() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe129() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe130() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe131() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe132() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe133() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe134() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe135() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe136() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe137() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe138() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe139() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe140() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe141() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe142() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe143() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe144() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe145() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe146() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe147() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe148() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe149() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe150() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe151() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe152() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe153() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe154() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe155() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe156() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe157() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe158() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe159() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe160() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe161() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe162() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe163() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe164() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe165() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe166() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe167() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe168() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe169() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe170() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe171() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe172() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe173() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe174() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe175() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe176() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe177() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe178() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe179() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe180() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe181() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe182() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe183() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe184() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe185() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe186() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe187() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe188() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe189() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe190() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe191() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe192() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe193() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe194() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe195() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe196() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe197() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe198() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe199() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe200() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe201() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe202() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe203() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe204() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe205() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe206() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe207() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe208() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe209() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe210() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe211() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe212() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe213() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe214() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe215() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe216() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe217() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe218() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe219() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe220() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe221() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe222() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe223() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe224() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe225() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe226() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe227() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe228() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe229() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe230() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe231() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe232() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe233() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe234() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe235() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe236() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe237() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe238() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe239() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe240() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe241() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe242() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe243() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe244() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe245() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe246() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe247() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe248() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe249() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe250() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe251() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe252() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe253() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe254() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe255() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testHelperLaunchDeliveryProbe256() async throws {
    try await testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath()
  }
  func testFragmentedLargeResponsesPreserveEveryByteAcrossRequests() async throws {
    let (helper, _) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import json, os, sys
      marker = chr(0x6c49) + chr(0x1f642) + chr(92) + chr(34) + chr(10)
      payload = ''.join(str(i) + ':' + 'abcdef0123456789' * 5 + ':' + marker for i in range(20000))
      for line in sys.stdin:
          requests = [json.loads(line), json.loads(sys.stdin.readline())]
          frames = []
          for request in requests:
              response = {'id': request['id'], 'status': 'succeeded',
                          'result': {'value': payload, 'sequence': request['sequence']}}
              frames.append(json.dumps(response, ensure_ascii=False).encode() + b'\n')
          data = b''.join(frames)
          step = 4093 + requests[0]['sequence'] % 3 * 4096
          for offset in range(0, len(data), step):
              chunk = memoryview(data)[offset:offset + step]
              while chunk:
                  chunk = chunk[os.write(1, chunk):]
      """#)
    let expected = (0..<20_000).map {
      "\($0):" + String(repeating: "abcdef0123456789", count: 5) + ":汉🙂\\\"\n"
    }.joined()

    for sequence in stride(from: 0, to: 16, by: 2) {
      async let first = helper.request(
        .object(["kind": .string("app.state"), "sequence": .number(Double(sequence))]))
      async let second = helper.request(
        .object(["kind": .string("app.state"), "sequence": .number(Double(sequence + 1))]))
      let responses = try await [first, second]
      for (offset, response) in responses.enumerated() {
        XCTAssertEqual(response["result"]["sequence"].number, Double(sequence + offset))
        XCTAssertTrue(
          response["result"]["value"].string == expected, "Fragmented response content changed")
      }
    }
  }

  func testFinalLargeResponseIsDrainedBeforeHelperExit() async throws {
    let collector = try telemetry()
    let (helper, _) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import json, os, signal, sys
      request = json.loads(sys.stdin.readline())
      data = json.dumps({'id': request['id'], 'status': 'succeeded',
                         'result': {'value': 'final-response-' * 131072}}).encode() + b'\n'
      chunk = memoryview(data)
      while chunk:
          chunk = chunk[os.write(1, chunk):]
      os.kill(os.getpid(), signal.SIGTERM)
      """#)
    let response = try await helper.request(.object(["kind": .string("app.state")]))
    XCTAssertTrue(
      response["result"]["value"].string == String(repeating: "final-response-", count: 131_072),
      "The helper's final response must be complete")
    await fulfillment(of: [collector.expectation(eventCount: 1)], timeout: 5)
    let event = try XCTUnwrap(collector.events().first)
    let diagnostics = event["contexts"]["nativeHelper"]
    XCTAssertEqual(diagnostics["pendingRequests"].number, 0)
    XCTAssertEqual(diagnostics["exitStatus"].number, 15)
    XCTAssertEqual(diagnostics["terminationReason"].string, "uncaught_signal")
  }

  func testInternalTimeoutReapsHelperBeforeFailureAndRecoversForANewCommand() async throws {
    let (executor, directory) = try fixture(
      #"""
      #!/usr/bin/python3
      import json, os, pathlib, sys
      attempts = pathlib.Path(os.environ['OKOU_NATIVE_TEST_DIRECTORY']) / 'attempts'
      for line in sys.stdin:
          request = json.loads(line)
          response = {'id': request['id'], 'status': 'succeeded'}
          if request['kind'] == 'permissions.state':
              response['result'] = {'accessibility': True, 'screenRecording': True}
          else:
              first = not attempts.exists()
              with attempts.open('a') as stream:
                  stream.write(str(os.getpid()) + '\n')
              if first:
                  response['status'] = 'failed'
                  response['error'] = {'code': 'target_app_unresponsive',
                                       'message': 'Synthetic internal watchdog timeout'}
              else:
                  response['result'] = {'apps': [{'bundleId': 'test.recovered'}]}
          print(json.dumps(response), flush=True)
      """#)

    let failed = await listApps(executor)
    XCTAssertEqual(failed["error"]["code"].string, "target_app_unresponsive")
    XCTAssertTrue(failed["error"]["message"].string?.contains("do not replay") == true)
    let attempts = directory.appendingPathComponent("attempts")
    let firstDispatch = try String(contentsOf: attempts, encoding: .utf8).split(separator: "\n")
    XCTAssertEqual(firstDispatch.count, 1)
    let retiredPID = try XCTUnwrap(firstDispatch.first.flatMap { Int32($0) })
    let processStatus = kill(retiredPID, 0)
    let processError = errno
    XCTAssertEqual(processStatus, -1)
    XCTAssertEqual(processError, ESRCH)

    let recovered = await listApps(executor)
    XCTAssertEqual(recovered["result"]["apps"].array?.first?["bundleId"].string, "test.recovered")
    let dispatches = try String(contentsOf: attempts, encoding: .utf8).split(separator: "\n")
    XCTAssertEqual(dispatches.count, 2)
    XCTAssertNotEqual(dispatches.first, dispatches.last)
  }
}
