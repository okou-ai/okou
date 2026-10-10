import Foundation
import XCTest

@testable import OkouCore

/// A claimed command as the API would deliver it, with only the fields a test varies.
private func claimedCommand(
  kind: String = "apps.list", payload: [String: JSONValue] = [:], timeoutMs: Int? = 60_000,
  createdAt: String, claimedAt: String?
) -> ComputerUseCommandClaim.Command {
  ComputerUseCommandClaim.Command(
    id: "command", kind: .init(rawValue: kind), status: .running, hostId: nil, hostName: nil,
    payload: payload, result: nil, error: nil, timeoutMs: timeoutMs, createdAt: createdAt,
    claimedAt: claimedAt, completedAt: nil)
}

final class CompatibilityTests: XCTestCase {
  func testAPIUsesTheCanonicalServiceOriginForProductionAndPreview() {
    for (source, expected) in [
      ("https://app.okou.ai", "https://api.okou.ai"),
      ("https://pr-42-app.omby.ai", "https://pr-42-api.vm6.ai"),
      ("https://staging-app.omby.ai", "https://staging-api.vm6.ai"),
      ("https://pr-42-app-okou-app-preview.vm0.workers.dev", "https://pr-42-api.vm6.ai"),
      ("http://localhost:3002", "http://localhost:3002"),
    ] { XCTAssertEqual(ServiceOrigin.api(for: URL(string: source)!).absoluteString, expected) }
  }
  func testExistingElectronPreferencesSurviveNativeWrites() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let id = UUID().uuidString.lowercased()
    let original: JSONValue = .object([
      "computerUseInstallationId": .string(id), "keepAwakeEnabled": .bool(true),
      "desktopLoginMethod": .string("browser"), "unrelatedPreference": .string("preserve"),
    ])
    let url = directory.appendingPathComponent("desktop-preferences.json")
    try JSONEncoder().encode(original).write(to: url)
    let preferences = try Preferences(directory: directory)
    XCTAssertEqual(try preferences.installationId, id)
    XCTAssertTrue(preferences.bool("keepAwakeEnabled"))
    try preferences.set("keepAwakeEnabled", .bool(false))
    let reopened = try Preferences(directory: directory)
    XCTAssertEqual(try reopened.installationId, id)
    let stored = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    XCTAssertEqual(stored["unrelatedPreference"].string, "preserve")
  }
  func testCorruptPreferencesAreReportedWithoutReplacingInstallationIdentity() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("desktop-preferences.json")
    try Data("[1]".utf8).write(to: url)
    XCTAssertThrowsError(try Preferences(directory: directory))
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "[1]")
  }
  func testExpiredClaimNeverReceivesAnExecutionBudget() throws {
    let claim = claimedCommand(
      timeoutMs: 1000, createdAt: "2026-10-07T00:00:00.000Z",
      claimedAt: "2026-10-07T00:00:02.000Z")
    XCTAssertEqual(try CommandBudget(command: claim, claimStarted: .now).remaining, 0)
    let invalid = claimedCommand(
      timeoutMs: 1000, createdAt: "2026-10-07T00:00:00.000Z", claimedAt: nil)
    XCTAssertThrowsError(try CommandBudget(command: invalid, claimStarted: .now))
  }
  func testAppStateAndIndexedClickCrossTheRealCommandPipeline() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let helper = directory.appendingPathComponent("helper")
    try """
    #!/usr/bin/python3
    import sys,json
    for line in sys.stdin:
        r=json.loads(line)
        if r['kind']=='permissions.state':
            result={'accessibility':True,'screenRecording':True}
        elif r['kind']=='app.state':
            result={'app':r['app'],'snapshotId':r['snapshotId'],'screenshot':'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=',
                    'screenshotSource':'window','screenshotWidth':1,'screenshotHeight':1,'screenshotSourceBounds':{'x':0,'y':0,'width':1,'height':1},
                    'elementIdsByIndex':['window','button-7'],'focusedElementIndex':1,'nodeCount':2,
                    'elements':[{'role':'AXWindow','children':[{'role':'AXButton','name':'7','actions':['AXPress','AXRaise']}]}]}
        else:
            result={'elementId':r['elementId'],'snapshotId':r['snapshotId']}
        print(json.dumps({'id':r['id'],'status':'succeeded','result':result}),flush=True)
    """.write(to: helper, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
    let executor = CommandExecutor(helper: NativeProcess(executable: helper))
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let time = formatter.string(from: Date())
    let state = await executor.execute(
      claimedCommand(
        kind: "app.state", payload: ["app": .string("Calculator")], createdAt: time,
        claimedAt: time),
      claimStarted: .now)
    XCTAssertEqual(state["status"].string, "succeeded")
    XCTAssertTrue(state["result"]["appState"].string!.contains("0 standard window"))
    XCTAssertTrue(
      state["result"]["appState"].string!.contains("1 button 7, Secondary Actions: Raise"))
    XCTAssertEqual(state["result"]["elements"], .null)
    let snapshot = state["result"]["snapshotId"]
    let click = await executor.execute(
      claimedCommand(
        kind: "element.click",
        payload: [
          "app": .string("Calculator"), "elementIndex": .number(1), "snapshotId": snapshot,
        ],
        createdAt: time, claimedAt: time),
      claimStarted: .now)
    XCTAssertEqual(click["status"].string, "succeeded")
    XCTAssertEqual(click["result"]["action"]["elementId"].string, "button-7")
    XCTAssertEqual(click["result"]["action"]["snapshotId"], snapshot)
    let wrongApp = await executor.execute(
      claimedCommand(
        kind: "element.click",
        payload: [
          "app": .string("Other app"), "elementIndex": .number(1), "snapshotId": snapshot,
        ],
        createdAt: time, claimedAt: time),
      claimStarted: .now)
    XCTAssertEqual(wrongApp["status"].string, "failed")
    XCTAssertEqual(wrongApp["error"]["code"].string, "invalid_arguments")
    await executor.stop()
  }
  func testNativeTransportCorrelatesRequestsAndRetiresInvalidHelper() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let helper = directory.appendingPathComponent("helper")
    try """
    #!/usr/bin/python3
    import sys,json
    for line in sys.stdin:
        request=json.loads(line)
        if request['kind']=='bad':
            print('invalid json',flush=True)
        else:
            print(json.dumps({'id':request['id'],'status':'succeeded','result':{'echo':request['kind']}}),flush=True)
    """.write(to: helper, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
    let native = NativeProcess(executable: helper)
    let first = try await native.request(.object(["kind": .string("first")]))
    XCTAssertEqual(first["result"]["echo"].string, "first")
    do {
      _ = try await native.request(.object(["kind": .string("bad")]))
      XCTFail("Expected protocol failure")
    } catch { XCTAssertTrue(error.localizedDescription.contains("invalid JSON")) }
    let fresh = try await native.request(.object(["kind": .string("fresh")]))
    XCTAssertEqual(fresh["result"]["echo"].string, "fresh")
    await native.stop()
  }
}
