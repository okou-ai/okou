import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class OnboardingTests: XCTestCase {
  func testDraftResumesAcrossOwnersAndPreservesNullableAnswersOnTheWire() async throws {
    let remote = OnboardingHTTPFixture()
    let store = remote.makeStore()
    defer { store.close() }
    await store.prepare()
    store.selectIndustry("software")
    await store.next()
    XCTAssertEqual(store.step, .sources)

    let reopened = remote.makeStore()
    defer { reopened.close() }
    await reopened.prepare()
    XCTAssertEqual(reopened.step, .sources)
    XCTAssertEqual(reopened.draft.answers.industry, "software")
    XCTAssertNotNil(reopened.draft.revision)
    let json = try XCTUnwrap(remote.state.withLock { $0.savedJSON })
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    let answers = try XCTUnwrap(body["answers"] as? [String: Any])
    XCTAssertTrue(answers["provider"] is NSNull)
    XCTAssertTrue(answers["experienced"] is NSNull)
    XCTAssertTrue(answers["startingPromptOutput"] is NSNull)
    XCTAssertTrue(answers["recommendationJobId"] is NSNull)
  }

  func testPersonalSubscriptionAddsTheOptionalSkillsStepAndSkipStillCompletesSetup() async throws {
    let remote = OnboardingHTTPFixture()
    let handoff = Mutex<String?>(nil)
    let store = remote.makeStore { prompt in handoff.withLock { $0 = prompt } }
    defer { store.close() }
    await store.prepare()
    store.selectIndustry("research")
    await store.next()
    await store.next(skip: true)
    store.selectExperience(true, provider: "codex")
    await store.next()
    XCTAssertEqual(store.step, .skills)
    await store.next(skip: true)
    XCTAssertEqual(store.step, .slack)
    await store.next(skip: true)
    await store.next()
    XCTAssertEqual(store.step, .ready)
    store.editPrompt("Compare the launch plans in my connected documents")
    await store.next()
    XCTAssertNil(store.error)
    XCTAssertEqual(handoff.withLock { $0 }, "Compare the launch plans in my connected documents")
    let status = try await remote.service.status()
    XCTAssertFalse(status.needsOnboarding)
  }

  func testLostCompletionResponseRecoversByReadingStatusBeforeAnotherWrite() async throws {
    let remote = OnboardingHTTPFixture()
    remote.state.withLock {
      var draft = OnboardingDraft()
      draft.step = .ready
      draft.answers.industry = "marketing"
      draft.answers.startingPromptDraft = "Draft a product launch brief"
      $0.draft = draft
      $0.loseCompletionResponse = true
    }
    let handoff = Mutex<String?>(nil)
    let store = remote.makeStore { prompt in handoff.withLock { $0 = prompt } }
    defer { store.close() }
    await store.prepare()
    await store.next()
    XCTAssertNotNil(store.error)
    XCTAssertNil(handoff.withLock { $0 })
    await store.next()
    XCTAssertNil(store.error)
    XCTAssertEqual(handoff.withLock { $0 }, "Draft a product launch brief")
    XCTAssertEqual(remote.state.withLock { $0.completionWrites }, 1)
  }

  func testConflictingDraftDoesNotAdvanceOrDiscardTheMembersSelection() async throws {
    let remote = OnboardingHTTPFixture()
    remote.state.withLock { $0.conflict = true }
    let store = remote.makeStore()
    defer { store.close() }
    await store.prepare()
    store.selectIndustry("design")
    await store.next()
    XCTAssertEqual(store.step, .industry)
    XCTAssertEqual(store.draft.answers.industry, "design")
    XCTAssertNotNil(store.error)
  }

  func testOlderServerWithoutTheOptionalRolloutFieldKeepsTheExistingEntry() async throws {
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(
        body: """
          {"needsOnboarding":true,"onboardingComplete":false,"isAdmin":true,"hasOrg":true}
          """)
    }
    let status = try await OnboardingService(client: fixture.client).status()
    XCTAssertFalse(status.presentsOnboarding)
  }
}

private final class OnboardingHTTPFixture: Sendable {
  struct State {
    var draft: OnboardingDraft?
    var savedJSON: String?
    var completed = false
    var completionWrites = 0
    var loseCompletionResponse = false
    var conflict = false
  }
  let state: Mutex<State>
  let fixture: ChatHTTPFixture
  var service: OnboardingService { OnboardingService(client: fixture.client) }

  init() {
    let state = Mutex(State())
    self.state = state
    fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      switch (request.httpMethod!, path) {
      case ("GET", "/api/onboarding/status"):
        return ChatHTTPResponse(
          body: state.withLock {
            "{\"needsOnboarding\":\(!($0.completed)),\"onboardingComplete\":\($0.completed),\"isAdmin\":false,\"hasOrg\":true,\"nativeOnboardingEnabled\":true}"
          })
      case ("GET", "/api/onboarding/draft"):
        struct Response: Encodable { let draft: OnboardingDraft? }
        return try ChatHTTPResponse(json: Response(draft: state.withLock { $0.draft }))
      case ("PUT", "/api/onboarding/draft"):
        let body = try request.onboardingBody()
        let saved = try JSONDecoder().decode(OnboardingDraft.self, from: body)
        return state.withLock {
          if $0.conflict {
            return ChatHTTPResponse(
              status: 409, body: "{\"error\":{\"message\":\"Setup changed on another device\"}}")
          }
          var draft = saved
          draft.revision = UUID().uuidString.lowercased()
          $0.draft = draft
          $0.savedJSON = String(data: body, encoding: .utf8)
          return ChatHTTPResponse(body: "{\"revision\":\"\(draft.revision!)\"}")
        }
      case ("POST", "/api/onboarding/recommendations"):
        return ChatHTTPResponse(
          status: 202, body: "{\"jobId\":\"\(UUID().uuidString)\",\"status\":\"pending\"}")
      case ("POST", "/api/onboarding/complete"):
        return state.withLock {
          $0.completed = true
          $0.completionWrites += 1
          if $0.loseCompletionResponse {
            return ChatHTTPResponse(
              status: 503, body: "{\"error\":{\"message\":\"Response lost\"}}")
          }
          return ChatHTTPResponse(body: "{\"onboardingComplete\":true,\"needsOnboarding\":false}")
        }
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor func makeStore(
    completion: @escaping @MainActor (String?) async throws -> Void = { _ in }
  ) -> OnboardingStore {
    OnboardingStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in }, didComplete: completion)
  }
}

extension URLRequest {
  fileprivate func onboardingBody() throws -> Data {
    if let httpBody { return httpBody }
    let stream = try XCTUnwrap(httpBodyStream)
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      body.append(contentsOf: buffer.prefix(count))
    }
    return body
  }
}
