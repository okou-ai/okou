import Foundation

public actor CommandExecutor {
  public static let capabilities = [
    "apps.list", "app.state", "app.open", "element.click", "element.scroll", "element.set_value",
    "element.perform_action", "keyboard.type_text", "keyboard.press_key",
  ]
  private let helper: NativeProcess
  private var snapshots: [String: JSONValue] = [:]
  private var latest: [String: String] = [:]
  private var snapshotOrder: [String] = []
  public init(helper: NativeProcess) { self.helper = helper }
  public func permissions() async throws -> JSONValue {
    try await call(.object(["kind": .string("permissions.state")]), remaining: 10)
  }
  public func requestPermission(screenRecording: Bool) async throws -> JSONValue {
    try await call(
      .object([
        "kind": .string(
          screenRecording
            ? "permissions.request_screen_recording" : "permissions.request_accessibility")
      ]), remaining: 30)
  }
  private func call(_ request: JSONValue, remaining: TimeInterval) async throws -> JSONValue {
    guard remaining > 0 else {
      throw DesktopFailure(
        "command_timeout", "Command expired before native dispatch; no action was started")
    }
    let response = try await helper.request(request, timeout: remaining)
    guard response["status"].string == "succeeded" else {
      throw DesktopFailure(
        response["error"]["code"].string ?? "accessibility_unavailable",
        response["error"]["message"].string ?? "Native request failed")
    }
    return response["result"]
  }
  public func execute(
    _ command: ComputerUseCommandClaim.Command, claimStarted: ContinuousClock.Instant
  ) async -> JSONValue {
    do {
      let kind = command.kind.rawValue
      guard Self.capabilities.contains(kind) else {
        throw DesktopFailure("unsupported_command", "Unsupported command: \(kind)")
      }
      let budget = try CommandBudget(command: command, claimStarted: claimStarted)
      let permissions = try await call(
        .object(["kind": .string("permissions.state")]), remaining: budget.remaining)
      guard permissions["accessibility"].bool == true else {
        throw DesktopFailure("permission_denied", "Accessibility permission is required")
      }
      // The helper speaks the contract's dynamic payload shape; keep it opaque here.
      var payload = JSONValue.object(command.payload)
      if kind == "apps.list" {
        let apps = try await call(.object(["kind": .string(kind)]), remaining: budget.remaining)
        return .object(["status": .string("succeeded"), "result": apps])
      }
      guard permissions["screenRecording"].bool == true else {
        throw DesktopFailure(
          "screen_recording_unavailable", "Screen Recording permission is required")
      }
      guard let app = payload["app"].string, !app.isEmpty else {
        throw DesktopFailure("invalid_arguments", "Missing app")
      }
      if kind == "app.state" { return try await state(app: app, settle: false, budget: budget) }
      if kind == "element.click", payload["x"].number != nil, payload["y"].number != nil,
        payload["elementId"].string == nil, payload["elementIndex"].number == nil
      {
        if latest[app.lowercased()] == nil, payload["snapshotId"].string == nil {
          _ = try await state(app: app, settle: false, budget: budget)
        }
        let snapshot = try resolveSnapshot(app: app, id: payload["snapshotId"].string)
        payload["kind"] = .string("element.click_point")
        for (key, value) in snapshot.object ?? [:]
        where [
          "snapshotId", "screenshotSource", "screenshotWidth", "screenshotHeight", "windowId",
          "windowFrame",
        ].contains(key) { payload[key] = value }
        payload["sourceBounds"] = snapshot["screenshotSourceBounds"]
      } else {
        payload["kind"] = .string(kind)
        if let index = payload["elementIndex"].number, payload["elementId"].string == nil {
          guard index >= 0, let elementIndex = Int(exactly: index) else {
            throw DesktopFailure("invalid_arguments", "Invalid element index")
          }
          let snapshot = try resolveSnapshot(app: app, id: payload["snapshotId"].string)
          guard let ids = snapshot["elementIdsByIndex"].array, elementIndex < ids.count,
            let id = ids[elementIndex].string, !id.isEmpty
          else {
            throw DesktopFailure(
              "invalid_arguments", "Element index is not present in the snapshot")
          }
          payload["elementId"] = .string(id)
          payload["snapshotId"] = snapshot["snapshotId"]
        }
      }
      if kind == "element.click" {
        if payload["button"] == .null { payload["button"] = .string("left") }
        if payload["clickCount"] == .null { payload["clickCount"] = .number(1) }
      }
      if kind == "element.scroll", payload["pages"] == .null { payload["pages"] = .number(1) }
      if ["element.click", "keyboard.type_text", "keyboard.press_key"].contains(kind),
        payload["foregroundRecovery"] == .null
      {
        payload["foregroundRecovery"] = .string("on-window-unavailable")
      }
      let action = try await call(payload, remaining: budget.remaining)
      var result = try await state(app: app, settle: true, budget: budget)
      result["result"]["action"] = action
      return result
    } catch let failure as DesktopFailure { return failure.response } catch is CancellationError {
      return DesktopFailure(
        "command_timeout",
        "Command authority was retired; completion may be unknown. Do not replay automatically."
      ).response
    } catch {
      return DesktopFailure("accessibility_unavailable", error.localizedDescription).response
    }
  }
  private func resolveSnapshot(app: String, id: String?) throws -> JSONValue {
    guard let id = id ?? latest[app.lowercased()], let snapshot = snapshots[id],
      snapshot["app"].string?.lowercased() == app.lowercased()
    else {
      throw DesktopFailure(
        "invalid_arguments", "No valid snapshot for this app; request app.state before acting")
    }
    return snapshot
  }
  private func state(app: String, settle: Bool, budget: CommandBudget) async throws -> JSONValue {
    let started = ContinuousClock.now
    let id = UUID().uuidString.lowercased()
    var snapshot = try await call(
      .object([
        "kind": .string("app.state"), "app": .string(app), "snapshotId": .string(id),
        "settle": .bool(settle),
      ]), remaining: budget.remaining)
    guard snapshot["screenshot"].string?.hasPrefix("data:image/png;base64,") == true,
      snapshot["screenshotSource"].string == "window",
      (snapshot["screenshotWidth"].number ?? 0) > 0,
      (snapshot["screenshotHeight"].number ?? 0) > 0,
      snapshot["screenshotSourceBounds"].object != nil
    else {
      throw DesktopFailure(
        "screen_recording_unavailable",
        "Native app.state did not return a valid target-window screenshot")
    }
    snapshots[id] = snapshot
    latest[app.lowercased()] = id
    snapshotOrder.append(id)
    if snapshotOrder.count > 50 { snapshots.removeValue(forKey: snapshotOrder.removeFirst()) }
    let tree = SnapshotRenderer.render(snapshot)
    snapshot["appState"] = .string(tree)
    snapshot["metrics"] = .object([
      "helperDurationMs": .number(started.duration(to: .now).seconds * 1000),
      "settle": .bool(settle), "rawNodeCount": snapshot["nodeCount"],
      "nodeCount": snapshot["nodeCount"], "appStateChars": .number(Double(tree.count)),
    ])
    var publicValues = snapshot.object ?? [:]
    publicValues.removeValue(forKey: "elements")
    return .object(["status": .string("succeeded"), "result": .object(publicValues)])
  }
  public func stop() async {
    await helper.stop()
    snapshots.removeAll()
    latest.removeAll()
    snapshotOrder.removeAll()
  }
}

public struct CommandBudget: Sendable {
  private let deadline: ContinuousClock.Instant
  public init(
    command: ComputerUseCommandClaim.Command, claimStarted: ContinuousClock.Instant
  ) throws {
    // The contract allows a null timeout; the API then applies its own maximum.
    let timeout = command.timeoutMs.map(Double.init) ?? 120_000
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard timeout >= 1000, timeout <= 120_000,
      let created = formatter.date(from: command.createdAt),
      let claimed = command.claimedAt.flatMap(formatter.date(from:)), claimed >= created
    else {
      throw DesktopFailure(
        "command_timeout", "Claim lacks a valid execution deadline; no action was dispatched")
    }
    let transport = claimStarted.duration(to: .now).seconds
    let remaining = max(0, timeout / 1000 - claimed.timeIntervalSince(created) - transport)
    deadline = .now.advanced(by: .seconds(max(0, remaining - min(1, remaining / 10))))
  }
  public var remaining: TimeInterval { max(0, ContinuousClock.now.duration(to: deadline).seconds) }
}

extension Duration {
  public var seconds: Double { Double(components.seconds) + Double(components.attoseconds) / 1e18 }
}
