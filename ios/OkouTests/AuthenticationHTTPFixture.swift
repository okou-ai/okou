import ChatDataTestSupport
import ClerkKit
import Foundation
import Network
import Synchronization
import XCTest

@testable import Okou

/// Isolated Clerk HTTP; SDK session restoration, decoding, and native routing stay real.
final class AuthenticationHTTPFixture: Sendable {
  struct State {
    var userID = "user_startup_" + UUID().uuidString
    var sessionID = "sess_startup_" + UUID().uuidString
    var activeWorkspaceID: String? = "org_one"
    var workspaceIDs = ["org_one"]
    var pending = false
    var signedOut = false
    var failMemberships = false
    var failActivation = false
  }

  let state = Mutex(State())
  let memberships = AuthenticationRequestGate()
  let activation = AuthenticationRequestGate()
  let api = ChatHTTPFixture { request in
    switch (request.httpMethod ?? "GET", request.url?.path ?? "") {
    case ("GET", "/api/agents"):
      return ChatHTTPResponse(body: "[]")
    case ("GET", "/api/user-preferences"):
      return ChatHTTPResponse(body: "{\"pinnedAgentIds\":[]}")
    case ("GET", "/api/feature-switches"):
      return ChatHTTPResponse(body: "{\"effectiveSwitches\":{}}")
    case ("GET", "/api/chat-threads/snapshot"):
      return ChatHTTPResponse(
        body: "{\"chatThreads\":[],\"latestEventId\":null,\"latestSeqId\":null}")
    case ("GET", "/api/chat-threads/events"):
      return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
    case ("GET", "/api/indicators"):
      return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
    case ("GET", "/api/user-model-preference"):
      return ChatHTTPResponse(body: "{}")
    case ("GET", "/api/run-models"):
      return runModelsResponse()
    case ("GET", "/api/model-catalog"):
      return modelCatalogResponse()
    case ("POST", "/api/realtime/token"):
      // Exercise startup without authorizing a connection to the external realtime service.
      return ChatHTTPResponse(
        status: 403, body: "{\"error\":{\"message\":\"No live updates in this fixture\"}}")
    default:
      throw URLError(.unsupportedURL)
    }
  }
  let host = "startup-" + UUID().uuidString.lowercased() + ".example.invalid"
  var publishableKey: String { "pk_test_" + Data((host + "$").utf8).base64EncodedString() }

  private let listener: NWListener
  private let connections = Mutex<[NWConnection]>([])
  private let tasks = Mutex<[Task<Void, Never>]>([])
  private let startup = Mutex<CheckedContinuation<URL, Error>?>(nil)
  private let queue = DispatchQueue(label: "ai.okou.tests.authentication")

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }

  @MainActor
  func authentication(resetPersistedIdentity: Bool = false) async throws -> AuthenticationService {
    let url = try await withCheckedThrowingContinuation { continuation in
      startup.withLock { $0 = continuation }
      listener.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .ready:
          let port = listener.port!.rawValue
          finish(.success(URL(string: "http://127.0.0.1:\(port)")!))
        case .failed(let error), .waiting(let error): finish(.failure(error))
        case .cancelled: finish(.failure(CancellationError()))
        default: break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        guard let self else {
          connection.cancel()
          return
        }
        connections.withLock { $0.append(connection) }
        connection.start(queue: queue)
        receive(connection, bytes: Data())
      }
      listener.start(queue: queue)
    }
    let options = Clerk.Options(telemetryEnabled: false, proxyUrl: url.absoluteString)
    let snapshot = state.withLock { value in
      let snapshot = value
      value.failActivation = false
      return snapshot
    }
    let clerk = Clerk.configure(publishableKey: publishableKey, options: options)
    if resetPersistedIdentity { try await Clerk.clearAllKeychainItemsAndWait() }
    _ = try await clerk.auth.signInWithPassword(
      identifier: "startup@example.invalid", password: "synthetic-password")
    state.withLock { $0 = snapshot }
    try await clerk.refreshClient()
    try await clerk.refreshEnvironment()
    // Recreate the SDK with its real persisted session, as on a cold launch.
    return AuthenticationService(
      clerk: Clerk.configure(publishableKey: publishableKey, options: options))
  }

  private func finish(_ result: Result<URL, Error>) {
    startup.withLock { value in
      value?.resume(with: result)
      value = nil
    }
  }

  private func receive(_ connection: NWConnection, bytes: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) {
      [weak self] data, _, complete, error in
      guard let self else {
        connection.cancel()
        return
      }
      var bytes = bytes
      if let data { bytes.append(data) }
      guard error == nil, bytes.count < 65_536 else {
        connection.cancel()
        return
      }
      if let separator = bytes.range(of: Data("\r\n\r\n".utf8)),
        let headers = String(data: bytes[..<separator.lowerBound], encoding: .utf8),
        let first = headers.components(separatedBy: "\r\n").first
      {
        let parts = first.split(separator: " ")
        let url = URL(string: "http://127.0.0.1" + parts[1])!
        var request = URLRequest(url: url)
        request.httpMethod = String(parts[0])
        for line in headers.components(separatedBy: "\r\n").dropFirst() {
          guard let colon = line.firstIndex(of: ":") else { continue }
          request.setValue(
            String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces),
            forHTTPHeaderField: String(line[..<colon]))
        }
        let body = Data(bytes[separator.upperBound...])
        let length = Int(request.value(forHTTPHeaderField: "Content-Length") ?? "0") ?? 0
        if body.count < length {
          receive(connection, bytes: bytes)
          return
        }
        request.httpBody = body
        let received = request
        let task = Task { @Sendable [self] in
          do {
            let result = try await response(received)
            try Task.checkCancellation()
            let body = Data(result.body.utf8)
            var headers = result.headers
            headers["Content-Length"] = String(body.count)
            headers["Connection"] = "close"
            let header = headers.map { "\($0.key): \($0.value)\r\n" }.joined()
            var bytes = Data("HTTP/1.1 \(result.status) Response\r\n\(header)\r\n".utf8)
            bytes.append(body)
            connection.send(
              content: bytes, completion: .contentProcessed { [self] _ in close(connection) })
          } catch { connection.cancel() }
        }
        tasks.withLock { $0.append(task) }
      } else if complete {
        connection.cancel()
      } else {
        receive(connection, bytes: bytes)
      }
    }
  }

  private func close(_ connection: NWConnection) {
    connection.cancel()
    connections.withLock { $0.removeAll { $0 === connection } }
  }

  func close() async {
    await memberships.releaseAll()
    await activation.releaseAll()
    listener.cancel()
    connections.withLock {
      for connection in $0 { connection.cancel() }
      $0.removeAll()
    }
    let pending = tasks.withLock { value in
      let pending = value
      value.removeAll()
      return pending
    }
    for task in pending { task.cancel() }
    for task in pending { await task.value }
  }

  func response(_ request: URLRequest) async throws -> ChatHTTPResponse {
    switch request.url!.path {
    case "/v1/environment":
      var response = try json(Clerk.Environment.mock)
      response.headers.removeValue(forKey: "Authorization")
      return response
    case "/v1/client/sign_ins":
      var signIn = SignIn.mock
      signIn.status = .complete
      signIn.createdSessionId = state.withLock { $0.sessionID }
      return try json(SignInEnvelope(response: signIn, client: client()))
    case "/v1/client":
      return try json(ClientEnvelope(response: client()))
    case "/v1/me/organization_memberships":
      let snapshot = state.withLock { $0 }
      await memberships.enter()
      if snapshot.failMemberships { return failure("Memberships unavailable") }
      let rows = snapshot.workspaceIDs.map { id in
        var membership = OrganizationMembership.mockWithoutUserData
        membership.id = "membership_" + id
        membership.organization.id = id
        membership.organization.name = id == "org_one" ? "First workspace" : "Second workspace"
        return membership
      }
      return try json(
        ResponseEnvelope(response: MembershipEnvelope(data: rows, totalCount: rows.count)))
    case let path where path.hasSuffix("/touch"):
      await activation.enter()
      if state.withLock({ $0.failActivation }) { return failure("Activation unavailable") }
      let body = String(decoding: chatRequestBody(request), as: UTF8.self)
      let workspaceID = URLComponents(string: "?" + body)?.queryItems?
        .first(where: { $0.name == "active_organization_id" })?.value
      state.withLock {
        $0.activeWorkspaceID = workspaceID
        $0.pending = false
      }
      let client = client()
      return try json(ActivationEnvelope(response: client.sessions[0], client: client))
    case let path
    where path.hasSuffix("/remove")
      || (path == "/v1/client/sessions" && request.httpMethod == "DELETE"):
      state.withLock { $0.signedOut = true }
      return try json(ClientEnvelope(response: client()))
    case let path where path.hasSuffix("/tokens"):
      let payload = Data("{\"exp\":4102444800,\"iat\":1792540800,\"sid\":\"sess_startup\"}".utf8)
        .base64EncodedString().replacingOccurrences(of: "=", with: "")
      return ChatHTTPResponse(body: "{\"jwt\":\"eyJhbGciOiJub25lIn0.\(payload).signature\"}")
    default:
      let message = "Unhandled Clerk HTTP request: \(request.httpMethod ?? "GET") \(request.url!)"
      await MainActor.run { XCTFail(message) }
      throw URLError(.unsupportedURL)
    }
  }

  private func client() -> Client {
    let snapshot = state.withLock { $0 }
    var user = User.mock
    user.id = snapshot.userID
    user.firstName = snapshot.userID.hasPrefix("user_startup_") ? "Startup" : "Replacement"
    user.hasImage = false
    user.imageUrl = ""
    var session = Session.mock
    session.id = snapshot.sessionID
    session.user = user
    session.status = snapshot.pending ? .pending : .active
    session.tasks = snapshot.pending ? [.chooseOrganization] : []
    session.lastActiveOrganizationId = snapshot.activeWorkspaceID
    return Client(
      id: "client_startup", sessions: snapshot.signedOut ? [] : [session],
      lastActiveSessionId: snapshot.signedOut ? nil : session.id, updatedAt: .now)
  }

  private func json(_ value: some Encodable) throws -> ChatHTTPResponse {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    encoder.dateEncodingStrategy = .millisecondsSince1970
    return ChatHTTPResponse(
      body: String(decoding: try encoder.encode(value), as: UTF8.self),
      headers: [
        "Content-Type": "application/json", "Authorization": "synthetic-startup-device",
      ])
  }

  private func failure(_ message: String) -> ChatHTTPResponse {
    ChatHTTPResponse(
      status: 400,
      body:
        "{\"errors\":[{\"code\":\"fixture_unavailable\",\"message\":\"\(message)\",\"long_message\":\"\(message)\"}]}"
    )
  }

  private struct ResponseEnvelope<Value: Encodable>: Encodable { let response: Value }
  private struct SignInEnvelope: Encodable {
    let response: SignIn
    let client: Client
  }
  private struct ClientEnvelope: Encodable { let response: Client }
  private struct ActivationEnvelope: Encodable {
    let response: Session
    let client: Client
  }
  private struct MembershipEnvelope: Encodable {
    let data: [OrganizationMembership]
    let totalCount: Int
  }
}

actor AuthenticationRequestGate {
  private var requests = 0
  private var open = true
  private var blocked: [Int: CheckedContinuation<Void, Never>] = [:]

  func hold() { open = false }
  var count: Int { requests }
  func enter() async {
    requests += 1
    let request = requests
    if !open {
      await withCheckedContinuation { blocked[request] = $0 }
    }
  }
  func release(_ request: Int) { blocked.removeValue(forKey: request)?.resume() }
  func releaseAll() {
    open = true
    let pending = blocked.values
    blocked.removeAll()
    for continuation in pending { continuation.resume() }
  }
}
