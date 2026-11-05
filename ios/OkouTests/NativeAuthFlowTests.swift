import ChatDataTestSupport
import ClerkKit
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class NativeAuthFlowTests: XCTestCase {
  func testEmailCodeFailureCanRetryWithoutCompletingAnUnverifiedIdentity() async throws {
    let fixture = try AuthenticationHTTPFixture()
    addTeardownBlock { await fixture.close() }
    let authentication = try await fixture.authentication()
    let clerk = try XCTUnwrap(authentication.clerk)
    try await clerk.auth.signOut()
    let server = NativeAuthIdentityFixture()
    fixture.identityOverride.withLock { $0 = { try server.response($0) } }
    var completions = 0
    let flow = NativeAuthFlow(clerk: clerk) { completions += 1 }
    addTeardownBlock { @MainActor in flow.cancel() }
    flow.email = "member@example.invalid"
    await flow.startEmail()?.value
    XCTAssertNil(flow.error)
    XCTAssertNil(clerk.session)
    XCTAssertEqual(completions, 0)

    flow.code = "000000"
    await flow.verify()?.value
    XCTAssertNotNil(flow.error)
    XCTAssertNil(clerk.session)
    XCTAssertEqual(completions, 0)

    flow.code = "123456"
    await flow.verify()?.value
    XCTAssertNil(flow.error)
    XCTAssertEqual(clerk.session?.user?.id, "user_native_auth")
    XCTAssertEqual(completions, 1)
    XCTAssertEqual(server.requests.withLock { $0.first?["identifier"] }, "member@example.invalid")
  }

  func testSecondFactorRequirementNeverActivatesOrCompletesTheAccount() async throws {
    let fixture = try AuthenticationHTTPFixture()
    addTeardownBlock { await fixture.close() }
    let authentication = try await fixture.authentication()
    let clerk = try XCTUnwrap(authentication.clerk)
    try await clerk.auth.signOut()
    let server = NativeAuthIdentityFixture(requiresMFA: true)
    fixture.identityOverride.withLock { $0 = { try server.response($0) } }
    var completed = false
    let flow = NativeAuthFlow(clerk: clerk) { completed = true }
    addTeardownBlock { @MainActor in flow.cancel() }
    flow.email = "member@example.invalid"
    await flow.startEmail()?.value
    flow.code = "123456"
    await flow.verify()?.value
    XCTAssertNil(flow.error)
    XCTAssertFalse(completed)
    XCTAssertNil(clerk.session)
    XCTAssertFalse(clerk.isAuthFlowComplete)
    XCTAssertEqual(clerk.client?.signIn?.status, .needsSecondFactor)
  }

  func testSignupKeepsRequiredFieldsAndExplicitConsentBeforeEmailVerification() async throws {
    let fixture = try AuthenticationHTTPFixture()
    addTeardownBlock { await fixture.close() }
    let authentication = try await fixture.authentication()
    let clerk = try XCTUnwrap(authentication.clerk)
    try await clerk.auth.signOut()
    let server = NativeAuthIdentityFixture()
    fixture.identityOverride.withLock { $0 = { try server.response($0) } }
    var completed = false
    let flow = NativeAuthFlow(clerk: clerk) { completed = true }
    addTeardownBlock { @MainActor in flow.cancel() }
    flow.switchMode()
    flow.email = "new-member@example.invalid"
    await flow.startEmail()?.value
    XCTAssertNil(flow.error)
    XCTAssertFalse(flow.canSubmitProfile)
    flow.firstName = "Native member"
    flow.password = "synthetic-test-password"
    XCTAssertFalse(flow.canSubmitProfile)
    XCTAssertNil(flow.submitProfile())
    flow.legalAccepted = true
    await flow.submitProfile()?.value
    XCTAssertNil(flow.error)
    XCTAssertEqual(
      server.requests.withLock { $0 }.first(where: { $0["first_name"] != nil })?["first_name"],
      "Native member")
    XCTAssertEqual(
      server.requests.withLock { $0 }.first(where: { $0["legal_accepted"] != nil })?[
        "legal_accepted"], "1")
    XCTAssertFalse(completed)
    XCTAssertNil(clerk.session)
    XCTAssertTrue(flow.password.isEmpty)
    XCTAssertEqual(clerk.client?.signUp?.unverifiedFields, [.emailAddress])
  }
}

/// External identity responses only; product operations and the pinned SDK remain real.
private final class NativeAuthIdentityFixture: Sendable {
  let requests = Mutex<[[String: String]]>([])
  private let requiresMFA: Bool

  init(requiresMFA: Bool = false) { self.requiresMFA = requiresMFA }

  func response(_ request: URLRequest) throws -> ChatHTTPResponse? {
    let path = request.url!.path
    guard path.contains("/sign_ins") || path.contains("/sign_ups") else { return nil }
    let parameters = parameters(request)
    requests.withLock { $0.append(parameters) }
    var client = Client(id: "client_startup", sessions: [], updatedAt: .now)
    if path.contains("/sign_ups") {
      var signUp = SignUp.mock
      signUp.id = "sua_native_auth"
      signUp.status = .missingRequirements
      signUp.requiredFields = [.emailAddress, .firstName, .password, .legalAccepted]
      signUp.unverifiedFields = [.emailAddress]
      signUp.missingFields =
        path == "/v1/client/sign_ups" ? [.firstName, .password, .legalAccepted] : []
      signUp.createdSessionId = nil
      client.signUp = signUp
      return try json(Envelope(response: signUp, client: client))
    }
    var signIn = SignIn(
      id: "sia_native_auth", status: .needsFirstFactor,
      supportedFirstFactors: [.init(strategy: .emailCode, emailAddressId: "idn_native_email")],
      firstFactorVerification: .init(status: .unverified, strategy: .emailCode))
    if path.hasSuffix("/attempt_first_factor") {
      if parameters["code"] != "123456" {
        return ChatHTTPResponse(
          status: 422,
          body:
            "{\"errors\":[{\"code\":\"form_code_incorrect\",\"message\":\"Incorrect verification code\",\"long_message\":\"The verification code is incorrect. Try again.\"}]}"
        )
      }
      if requiresMFA {
        signIn.status = .needsSecondFactor
        signIn.supportedSecondFactors = [.init(strategy: .totp)]
      } else {
        var session = Session.mock
        session.id = "sess_native_auth"
        session.user?.id = "user_native_auth"
        session.status = .active
        session.tasks = []
        client.sessions = [session]
        client.lastActiveSessionId = session.id
        signIn.status = .complete
        signIn.createdSessionId = session.id
      }
    }
    client.signIn = signIn
    return try json(Envelope(response: signIn, client: client))
  }

  private func parameters(_ request: URLRequest) -> [String: String] {
    let body = chatRequestBody(request)
    if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
      return json.mapValues { value in
        if let boolean = value as? Bool { return boolean ? "true" : "false" }
        return String(describing: value)
      }
    }
    return Dictionary(
      uniqueKeysWithValues: (URLComponents(string: "?" + String(decoding: body, as: UTF8.self))?
        .queryItems ?? []).map { ($0.name, $0.value ?? "") })
  }

  private func json(_ value: some Encodable) throws -> ChatHTTPResponse {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    encoder.dateEncodingStrategy = .millisecondsSince1970
    return ChatHTTPResponse(
      body: String(decoding: try encoder.encode(value), as: UTF8.self),
      headers: [
        "Content-Type": "application/json", "Authorization": "synthetic-native-auth-device",
      ])
  }

  private struct Envelope<Value: Encodable>: Encodable {
    let response: Value
    let client: Client
  }
}
