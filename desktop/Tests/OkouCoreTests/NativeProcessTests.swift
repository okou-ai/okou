import Darwin
import Foundation
import XCTest

import OkouCore

@MainActor
final class NativeProcessTests: XCTestCase {
  private func telemetry() throws -> SentryHTTPCollector {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    return collector
  }

  private func nativeFixture(_ source: String) throws -> (NativeProcess, URL) {
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
    return (helper, directory)
  }

  private func fixture(_ source: String) throws -> (CommandExecutor, URL) {
    let (helper, directory) = try nativeFixture(source)
    return (CommandExecutor(helper: helper), directory)
  }

  private func listApps(_ executor: CommandExecutor, timeoutMs: Int = 5000) async -> JSONValue {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timestamp = formatter.string(from: Date())
    let command = ComputerUseCommandClaim.Command(
      id: UUID().uuidString, kind: .appsList, status: .running, hostId: "computer", hostName: "Mac",
      payload: [:], result: nil, error: nil, timeoutMs: timeoutMs, createdAt: timestamp,
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
    XCTAssertTrue(details.contains("readSequence="))

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
    let event = try XCTUnwrap(collector.events().first)
    let attachments = try collector.attachments(for: event)
    let expected = try Data(contentsOf: directory.appendingPathComponent("malformed-response.bin"))
    let received = try XCTUnwrap(attachments["native-helper-response.bin"])
    XCTAssertFalse(event.formatted.contains("0123456789abcdefghijklmnopqrstuvwxyz"))
    let details = String(
      decoding: try XCTUnwrap(attachments["native-helper-diagnostics.txt"]), as: UTF8.self)
    let mismatch = zip(received, expected).enumerated().first { $0.element.0 != $0.element.1 }?.offset
    XCTAssertEqual(received, expected, "firstMismatchOffset=\(String(describing: mismatch))\n\(details)")
    XCTAssertTrue(details.contains("responseBytes=\(expected.count)"))
    XCTAssertTrue(details.contains("responseTruncated=false"))
    XCTAssertTrue(details.contains("DecodingError"))
    XCTAssertTrue(details.contains("readTraceComplete="))
    XCTAssertTrue(details.contains("readSequence="))
  }

  func testProtocolAttachmentsAreBoundedAcrossHelperRestartsWithoutDroppingErrorEvents() async throws {
    let collector = try telemetry()
    let (executor, _) = try fixture(
      #"""
      #!/usr/bin/python3
      import json, os, pathlib, sys
      attempts = pathlib.Path(os.environ['OKOU_NATIVE_TEST_DIRECTORY']) / 'attempts'
      for line in sys.stdin:
          request = json.loads(line)
          if request['kind'] == 'permissions.state':
              print(json.dumps({'id': request['id'], 'status': 'succeeded',
                                'result': {'accessibility': True, 'screenRecording': True}}), flush=True)
          else:
              count = int(attempts.read_text()) if attempts.exists() else 0
              attempts.write_text(str(count + 1))
              payload = b'x' * (4 * 1024 * 1024 + 4096) if count == 0 else b'broken-response'
              sys.stdout.buffer.write(payload + b'\n')
              sys.stdout.buffer.flush()
      """#)

    for _ in 0..<4 {
      let failed = await listApps(executor)
      XCTAssertEqual(failed["status"].string, "failed")
    }
    let events = try collector.events()
    XCTAssertEqual(events.count, 4)
    XCTAssertTrue(
      events.contains {
        $0["contexts"]["nativeHelper"]["responseBytes"].number == Double(4 * 1024 * 1024 + 4096)
      })
    var attached = 0
    var limited = 0
    for event in events {
      let attachments = try collector.attachments(for: event)
      if event["contexts"]["nativeHelper"]["diagnosticAttachments"].string == "rate_limited" {
        limited += 1
        XCTAssertTrue(attachments.isEmpty)
      } else {
        attached += 1
        let raw = try XCTUnwrap(attachments["native-helper-response.bin"])
        XCTAssertLessThanOrEqual(raw.count, 4 * 1024 * 1024)
        let report = try XCTUnwrap(attachments["native-helper-diagnostics.txt"])
        XCTAssertLessThan(report.count, 65_536)
        let details = String(decoding: report, as: UTF8.self)
        XCTAssertLessThanOrEqual(
          details.components(separatedBy: "\n").filter { $0.hasPrefix("readSequence=") }.count, 256)
        if event["contexts"]["nativeHelper"]["responseBytes"].number
          == Double(4 * 1024 * 1024 + 4096)
        {
          XCTAssertEqual(raw, Data(repeating: 120, count: 4 * 1024 * 1024))
          XCTAssertTrue(details.contains("responseTruncated=true"))
        }
      }
    }
    XCTAssertEqual(attached, 3)
    XCTAssertEqual(limited, 1)
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
      String(repeating: "0123456789abcdefghijklmnopqrstuvwxyz", count: 44738).prefix(1610565))
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

  func testUnexpectedHelperExitIsDeliveredToSentry() async throws {
    let collector = try telemetry()
    let (executor, _) = try fixture(
      #"""
      #!/usr/bin/python3
      import os, sys
      for line in sys.stdin:
          os._exit(23)
      """#)
    let response = await listApps(executor)
    XCTAssertEqual(response["status"].string, "failed")
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "unexpected_exit")
    XCTAssertEqual(event["contexts"]["nativeHelper"]["exitStatus"].number, 23)
  }

  func testHelperTimeoutIsDeliveredToSentry() async throws {
    let collector = try telemetry()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("helper")
    try #"""
      #!/usr/bin/python3
      import sys
      for line in sys.stdin:
          pass
      """#.write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let helper = NativeProcess(executable: executable)
    addTeardownBlock {
      await helper.stop()
      try FileManager.default.removeItem(at: directory)
    }
    do {
      _ = try await helper.request(.object(["kind": .string("apps.list")]), timeout: 0.1)
      XCTFail("An unanswered helper request must fail at its deadline")
    } catch let failure as DesktopFailure {
      XCTAssertEqual(failure.code, "command_timeout")
    }
    let events = try collector.events()
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?["tags"]["nativeHelperFailure"].string, "timeout")
  }

  func testHelperLaunchFailureIsDeliveredWithoutTheExecutablePath() async throws {
    let collector = try telemetry()
    let helper = NativeProcess(
      executable: URL(fileURLWithPath: "/nonexistent/private-helper-installation/helper"))
    let executor = CommandExecutor(helper: helper)
    let response = await listApps(executor)
    XCTAssertEqual(response["status"].string, "failed")
    let event = try XCTUnwrap(collector.events().first)
    XCTAssertEqual(event["tags"]["nativeHelperFailure"].string, "launch_failed")
    XCTAssertFalse(event.formatted.contains("private-helper-installation"))
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
    let (helper, _) = try nativeFixture(
      #"""
      #!/usr/bin/python3
      import json, os, sys
      request = json.loads(sys.stdin.readline())
      data = json.dumps({'id': request['id'], 'status': 'succeeded',
                         'result': {'value': 'final-response-' * 131072}}).encode() + b'\n'
      chunk = memoryview(data)
      while chunk:
          chunk = chunk[os.write(1, chunk):]
      os._exit(0)
      """#)
    let response = try await helper.request(.object(["kind": .string("app.state")]))
    XCTAssertTrue(
      response["result"]["value"].string == String(repeating: "final-response-", count: 131_072),
      "The helper's final response must be complete")
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
