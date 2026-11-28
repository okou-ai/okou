import CCState
import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComposerConnectorPermissionTests: XCTestCase {
  func testSettingsPermissionSaveDoesNotDependOnRemoteOverview() async throws {
    let server = PermissionEditorFixture()
    let composer = ComposerConnectorStore(
      service: ChatComposerAccess(client: server.http.client),
      authorizationService: ChatConnectorService(client: server.http.client),
      webURL: server.http.baseURL, graph: makeTestWorkspaceGraph(), includesRemote: false,
      didFail: { _ in })
    defer { composer.close() }
    await composer.refresh()
    let resources = try open(composer)
    await resources.apply(.allow("mail.send"))
    let saved = await resources.save()
    XCTAssertTrue(saved)
    XCTAssertTrue(composer.canSend)
    XCTAssertTrue(server.requests(path: "/api/remotes/overview").isEmpty)
    let reopened = try open(composer)
    let confirmed = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(confirmed.state.grants.first?.permission, "mail.send")
  }

  func testEditsAndResetStayLocalUntilApplyAndClosingDiscardsThem() async throws {
    let server = PermissionEditorFixture()
    let composer = makeComposer(server.http)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.apply(.allow("mail.send"))
    let staged = try await resources.store.get(resources.page).value
    XCTAssertEqual(staged.policy(for: "mail.send"), .allow)
    XCTAssertTrue(staged.state.grants.isEmpty)
    XCTAssertTrue(server.writes.isEmpty)
    await resources.apply(.reset)
    let reset = try await resources.store.get(resources.page).value
    XCTAssertEqual(reset.policy(for: "mail.send"), .ask)
    XCTAssertTrue(server.writes.isEmpty)
    composer.closePermissions()
    let reopened = try open(composer)
    XCTAssertFalse(try reopened.store.get(reopened.controls).hasChanges)
    await reopened.apply(.denyGroup(["mail.read", "mail.send"]))
    XCTAssertTrue(server.writes.isEmpty)
    let saved = await reopened.save()
    XCTAssertTrue(saved)
    XCTAssertEqual(server.writes.count, 1)
    let confirmed = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(confirmed.state.grants.map(\.permission).sorted(), ["mail.read", "mail.send"])
    XCTAssertFalse(try reopened.store.get(reopened.controls).hasChanges)
  }

  func testConsumersSharePermissionsAndFilterLocallyWithoutRefetching() async throws {
    let server = PermissionEditorFixture()
    let composer = makeComposer(server.http)
    defer { composer.close() }
    let resources = try open(composer)
    let first = try own(resources.store.get(resources.page))
    let second = try own(resources.store.get(resources.page))
    let all = try await first.value
    let shared = try await second.value
    XCTAssertEqual(all.permissions.count, 3)
    XCTAssertEqual(shared.state.metadata.connectorSlug, "gmail")
    resources.update(search: "SEND", category: "Mail", duration: "24h")
    let filtered = try await resources.store.get(resources.page).value
    XCTAssertEqual(filtered.permissions.map(\.name), ["mail.send"])
    resources.update(search: "nothing")
    let empty = try await resources.store.get(resources.page).value
    XCTAssertTrue(empty.permissions.isEmpty)
    XCTAssertEqual(server.requests(path: "/api/connector-catalog/gmail/permissions").count, 1)
    let grants = try XCTUnwrap(server.requests(path: "/api/connector-permissions").first)
    let query = URLComponents(url: grants.url!, resolvingAgainstBaseURL: false)?.queryItems
    XCTAssertEqual(query?.first { $0.name == "kind" }?.value, "builtin")
    XCTAssertEqual(query?.first { $0.name == "connectorSlug" }?.value, "gmail")
  }

  func testFilteredBulkChangeSingleDenyAndResetReadBackCanonicalRules() async throws {
    let server = PermissionEditorFixture()
    let composer = makeComposer(server.http)
    defer { composer.close() }
    let resources = try open(composer)
    resources.update(category: "Mail", duration: "24h")
    await resources.apply(.allowListed)
    _ = await resources.save()
    let allowed = try await resources.store.get(resources.page).value
    XCTAssertEqual(allowed.state.grants.map(\.permission).sorted(), ["mail.read", "mail.send"])
    XCTAssertTrue(
      allowed.state.grants.allSatisfy { $0.action.rawValue == "allow" && $0.expiresAt != nil })
    let request = try XCTUnwrap(server.writes.first)
    let body = try JSONDecoder().decode(
      PermissionEditorFixture.Write.self, from: chatRequestBody(request))
    XCTAssertEqual(body.target.kind, "builtin")
    XCTAssertEqual(body.target.connectorSlug, "gmail")
    XCTAssertEqual(body.mode, "patch")
    XCTAssertEqual(body.grants.map(\.expiresIn), ["24h", "24h"])
    await resources.apply(.deny("__unknown__"))
    _ = await resources.save()
    let denied = try await resources.store.get(resources.page).value
    XCTAssertEqual(
      denied.state.metadata.policy(for: "__unknown__", grants: denied.state.grants, at: .now), .deny
    )
    await resources.apply(.reset)
    _ = await resources.save()
    let reset = try await resources.store.get(resources.page).value
    XCTAssertTrue(reset.state.grants.isEmpty)
    XCTAssertEqual(
      reset.state.metadata.policy(for: "mail.send", grants: reset.state.grants, at: .now), .ask)
    XCTAssertTrue(composer.canSend)
    let last = try XCTUnwrap(server.writes.last)
    let resetBody = try JSONDecoder().decode(
      PermissionEditorFixture.Write.self, from: chatRequestBody(last))
    XCTAssertEqual(resetBody.mode, "replace")
    XCTAssertTrue(resetBody.grants.isEmpty)
  }

  func testDirectoryAndPermissionReadsKeepIndependentLifetimes() async throws {
    let server = PermissionEditorFixture()
    let composer = makeComposer(server.http)
    defer { composer.close() }
    composer.openDirectory()
    let directory = try XCTUnwrap(composer.directory)
    let catalog = try await directory.store.get(directory.catalog).value
    let connector = try XCTUnwrap(catalog.connectors.first)
    composer.openPermissions(slug: connector.slug, label: connector.label)
    let resources = try XCTUnwrap(composer.permissions)
    let page = try await resources.store.get(resources.page).value
    XCTAssertEqual(page.state.metadata.label, "Gmail")
    composer.closePermissions()
    let reused = try await directory.store.get(directory.catalog).value
    XCTAssertEqual(reused.connectors.first?.slug, "gmail")
    XCTAssertEqual(server.requests(path: "/api/connector-catalog/discovery").count, 1)
  }

  func testAlwaysAllowPersistsWithoutExpiration() async throws {
    let server = PermissionEditorFixture()
    let composer = makeComposer(server.http)
    defer { composer.close() }
    let resources = try open(composer)
    resources.update(duration: "always")
    await resources.apply(.allow("mail.send"))
    _ = await resources.save()
    let value = try await resources.store.get(resources.page).value
    XCTAssertEqual(value.state.grants.first?.permission, "mail.send")
    XCTAssertNil(value.state.grants.first?.expiresAt)
    let request = try XCTUnwrap(server.writes.first)
    XCTAssertEqual(request.url?.path, "/api/connector-permissions")
    let body = try JSONDecoder().decode(
      PermissionEditorFixture.Write.self, from: chatRequestBody(request))
    XCTAssertEqual(body.target.kind, "builtin")
    XCTAssertEqual(body.target.connectorSlug, "gmail")
  }

  func testReadFailureRemainsAnErrorUntilExplicitRetry() async throws {
    let server = PermissionEditorFixture()
    server.state.withLock { $0.failRead = true }
    let composer = makeComposer(server.http)
    defer { composer.close() }
    let resources = try open(composer)
    let first = try own(resources.store.get(resources.page))
    if case .success = await first.result {
      XCTFail("Unavailable permissions became successful data")
    }
    server.state.withLock { $0.failRead = false }
    let cached = try own(resources.store.get(resources.page))
    if case .success = await cached.result { XCTFail("Observation silently retried permissions") }
    XCTAssertEqual(server.requests(path: "/api/connector-catalog/gmail/permissions").count, 1)
    await resources.retry()
    let value = try await resources.store.get(resources.page).value
    XCTAssertEqual(value.permissions.count, 3)
    XCTAssertEqual(server.requests(path: "/api/connector-catalog/gmail/permissions").count, 2)
  }

  func testRejectedWriteRequiresReadbackBeforeAnotherChangeAndDoesNotReplay() async throws {
    let server = PermissionEditorFixture()
    server.state.withLock { $0.writeStatus = 403 }
    let composer = makeComposer(server.http)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.apply(.allow("mail.send"))
    _ = await resources.save()
    XCTAssertFalse(composer.canSend)
    let controls = try resources.store.get(resources.controls)
    XCTAssertTrue(controls.confirmationFailure?.contains("Permission change rejected") == true)
    await resources.apply(.allow("mail.send"))
    _ = await resources.save()
    XCTAssertEqual(server.writes.count, 1)
    server.state.withLock { $0.writeStatus = 200 }
    await resources.retry()
    XCTAssertTrue(composer.canSend)
    XCTAssertNil(try resources.store.get(resources.controls).confirmationFailure)
    await resources.apply(.allow("mail.send"))
    _ = await resources.save()
    let value = try await resources.store.get(resources.page).value
    XCTAssertEqual(value.state.grants.first?.action.rawValue, "allow")
    XCTAssertEqual(server.writes.count, 2)
  }

  func testLostWriteResponseReconcilesWithoutRepeatingThePermissionChange() async throws {
    let server = PermissionEditorFixture()
    server.state.withLock { $0.loseWriteResponse = true }
    let composer = makeComposer(server.http)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.apply(.deny("mail.send"))
    _ = await resources.save()
    let value = try await resources.store.get(resources.page).value
    XCTAssertEqual(value.state.grants.first?.action.rawValue, "deny")
    XCTAssertTrue(composer.canSend)
    XCTAssertEqual(server.writes.count, 1)
  }

  func testRetiredEditorCancelsOriginalHTTPAndCannotPublishOrWriteForTheNewEditor() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Permission read reached HTTP")
    let cancelled = expectation(description: "Original permission HTTP cancelled")
    let hold = Mutex(true)
    let server = PermissionEditorFixture { request in
      if request.url?.path == "/api/connector-catalog/gmail/permissions",
        hold.withLock({ value in
          let previous = value
          value = false
          return previous
        })
      {
        await withTaskCancellationHandler {
          started.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
    }
    let composer = makeComposer(server.http)
    defer {
      composer.close()
      gate.open()
    }
    let resources = try open(composer)
    let pending = try own(resources.store.get(resources.page))
    await fulfillment(of: [started], timeout: 3)
    composer.closePermissions()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    if case .success = await pending.result {
      XCTFail("A retired editor published old permissions")
    }
    await resources.apply(.allow("mail.send"))
    _ = await resources.save()
    XCTAssertTrue(server.writes.isEmpty)
    composer.openPermissions(slug: "gmail", label: "Gmail")
    let next = try XCTUnwrap(composer.permissions)
    await next.apply(.deny("mail.read"))
    _ = await next.save()
    let request = try XCTUnwrap(server.writes.first)
    let body = try JSONDecoder().decode(
      PermissionEditorFixture.Write.self, from: chatRequestBody(request))
    XCTAssertEqual(body.target.connectorSlug, "gmail")
    XCTAssertEqual(body.grants.first?.permission, "mail.read")
    XCTAssertEqual(body.grants.first?.action, "deny")
  }

  func testDismissingTheEditorKeepsTheComposerOwnedWriteAndReadback() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Permission write reached HTTP")
    let server = PermissionEditorFixture { request in
      if request.httpMethod == "PUT" {
        started.fulfill()
        await gate.wait()
      }
    }
    let composer = makeComposer(server.http)
    let resources = try open(composer)
    await resources.apply(.allow("mail.send"))
    let write = Task { _ = await resources.save() }
    addTeardownBlock {
      write.cancel()
      gate.open()
      await write.value
    }
    defer {
      composer.close()
      gate.open()
    }
    await fulfillment(of: [started], timeout: 3)
    composer.closePermissions()
    composer.openPermissions(slug: "gmail", label: "Gmail")
    let reopened = try XCTUnwrap(composer.permissions)
    let before = try await reopened.store.get(reopened.page).value
    XCTAssertTrue(before.state.grants.isEmpty)
    gate.open()
    await write.value
    XCTAssertTrue(composer.canSend)
    let value = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(value.state.grants.first?.action.rawValue, "allow")
    XCTAssertEqual(server.writes.count, 1)
  }

  private func makeComposer(_ fixture: ChatHTTPFixture) -> ComposerConnectorStore {
    let composer = ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.client),
      authorizationService: ChatConnectorService(client: fixture.client), webURL: fixture.baseURL,
      graph: makeTestWorkspaceGraph(), didFail: { _ in })
    return composer
  }

  private func open(_ composer: ComposerConnectorStore) throws
    -> ComposerConnectorPermissionResources
  {
    composer.openPermissions(slug: "gmail", label: "Gmail")
    return try XCTUnwrap(composer.permissions)
  }

  private func own<Value: Sendable>(_ task: Task<Value, Error>) -> Task<Value, Error> {
    addTeardownBlock {
      task.cancel()
      _ = await task.result
    }
    return task
  }
}

/// The real permission and composer HTTP contracts; no application-owned state is mocked.
final class PermissionEditorFixture: Sendable {
  struct Edit: Codable, Sendable {
    let permission: String
    let action: String
    let expiresIn: String?
  }
  struct Target: Decodable, Sendable {
    let kind: String
    let connectorSlug: String
  }
  struct Write: Decodable, Sendable {
    let target: Target
    let mode: String
    let grants: [Edit]
  }
  struct State: Sendable {
    var failRead = false
    var writeStatus = 200
    var loseWriteResponse = false
    var grants: [String: Edit] = [:]
    var expirations: [String: String] = [:]
    var requests: [URLRequest] = []
  }
  final class ServerState: Sendable {
    private let storage = Mutex(State())
    func withLock<T>(_ operation: (inout State) throws -> T) rethrows -> T {
      try storage.withLock { try operation(&$0) }
    }
  }
  let state: ServerState
  let http: ChatHTTPFixture
  var writes: [URLRequest] { state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } } }
  func requests(path: String) -> [URLRequest] {
    state.withLock { $0.requests.filter { $0.url?.path == path } }
  }

  init(before: @escaping @Sendable (URLRequest) async -> Void = { _ in }) {
    let state = ServerState()
    self.state = state
    http = ChatHTTPFixture { request in
      await before(request)
      var request = request
      request.httpBody = chatRequestBody(request)
      return try state.withLock { value in
        value.requests.append(request)
        let path = request.url!.path
        if request.httpMethod == "PUT" {
          guard path == "/api/connector-permissions"
          else {
            throw URLError(.unsupportedURL)
          }
          if value.writeStatus != 200 {
            return ChatHTTPResponse(
              status: value.writeStatus,
              body: #"{"error":{"message":"Permission change rejected"}}"#)
          }
          let body = try JSONDecoder().decode(Write.self, from: chatRequestBody(request))
          if body.mode == "replace" {
            value.grants = [:]
            value.expirations = [:]
          }
          for edit in body.grants {
            value.grants[edit.permission] = edit
            let seconds: [String: TimeInterval] = ["1h": 3600, "24h": 86400, "7d": 604800]
            if edit.action == "allow", let duration = edit.expiresIn,
              let interval = seconds[duration]
            {
              value.expirations[edit.permission] = Date.now.addingTimeInterval(interval).formatted(
                .iso8601)
            } else {
              value.expirations[edit.permission] = nil
            }
          }
          if value.loseWriteResponse {
            value.loseWriteResponse = false
            return ChatHTTPResponse(
              status: 503, body: #"{"error":{"message":"Write response lost"}}"#)
          }
          return ChatHTTPResponse(body: try Self.grants(value))
        }
        switch path {
        case "/api/connector-catalog/discovery":
          return ChatHTTPResponse(body: Self.catalog)
        case "/api/connector-catalog/gmail/permissions":
          if value.failRead {
            return ChatHTTPResponse(
              status: 503, body: #"{"error":{"message":"Permission service unavailable"}}"#)
          }
          return ChatHTTPResponse(body: Self.metadata)
        case "/api/connector-permissions":
          return ChatHTTPResponse(body: try Self.grants(value))
        case "/api/chat-connector-overview":
          return ChatHTTPResponse(body: "[]")
        case "/api/remotes/overview":
          return ChatHTTPResponse(
            body:
              #"{"computerUseHosts":[],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[],"vncHosts":[]}"#
          )
        default:
          throw URLError(.unsupportedURL)
        }
      }
    }
  }

  private static func grants(_ state: State) throws -> String {
    let grants: [[String: Any]] = state.grants.keys.sorted().compactMap { name in
      guard let edit = state.grants[name] else { return nil }
      return [
        "permission": edit.permission, "action": edit.action,
        "expiresAt": state.expirations[edit.permission].map { $0 as Any } ?? NSNull()
      ]
    }
    let body: [String: Any] = [
      "target": ["kind": "builtin", "connectorSlug": "gmail"], "grants": grants
    ]
    return try JSONSerialization.string(withJSONObject: body)
  }

  static let catalog =
    #"{"connectors":[{"slug":"gmail","label":"Gmail","description":"Email and calendar for your work","category":"communication-collaboration","authMethods":[{"id":"oauth","label":"Google","grantKind":"oauth","manualFields":[],"startOptions":[]}],"permissionSummary":{"hasPermissions":true}}],"totalConnectorCount":1,"categoryConnectorCounts":{"communication-collaboration":1}}"#

  static let metadata =
    #"{"permissions":{"connectorSlug":"gmail","label":"Gmail","permissions":[{"name":"mail.read","description":"Read your mail"},{"name":"mail.send","description":"Send email from your account"},{"name":"calendar.list","description":"List calendar events"}],"defaultPolicy":{"permissionDefault":"ask","unknownPolicy":"ask"},"categories":{"categories":{"mail.read":"Mail","mail.send":"Mail","calendar.list":"Calendar"},"displayOrder":["Mail","Calendar"]}}}"#
}
