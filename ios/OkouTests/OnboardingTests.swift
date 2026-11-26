import CCState
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
    let json = try XCTUnwrap(remote.state.value.withLock { $0.savedJSON })
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    let answers = try XCTUnwrap(body["answers"] as? [String: Any])
    XCTAssertTrue(answers["provider"] is NSNull)
    XCTAssertTrue(answers["experienced"] is NSNull)
    XCTAssertTrue(answers["startingPromptOutput"] is NSNull)
    XCTAssertTrue(answers["recommendationJobId"] is NSNull)
  }

  func testThreeStepSetupSuggestsATaskAndRunsTheReviewedTextOnConfirmation() async throws {
    let remote = OnboardingHTTPFixture()
    let opened = Mutex<String?>(nil)
    let store = remote.makeStore { thread in opened.withLock { $0 = thread } }
    defer { store.close() }
    await store.prepare()
    store.selectIndustry("research")
    await store.next()
    XCTAssertEqual(store.step, .sources)
    await store.next(skip: true)
    XCTAssertEqual(store.step, .ready)
    XCTAssertFalse(store.draft.answers.startingPromptDraft.isEmpty)
    store.editPrompt("Compare the launch plans in my connected documents")
    await store.next()
    XCTAssertNil(store.snapshot.error)
    let threadID = try XCTUnwrap(opened.withLock { $0 })
    let messages = remote.state.value.withLock { Array($0.messages.values) }
    XCTAssertEqual(messages.map(\.prompt), ["Compare the launch plans in my connected documents"])
    XCTAssertEqual(messages.map(\.threadID), [threadID])
    let status = try await remote.service.status()
    XCTAssertFalse(status.needsOnboarding)
  }

  func testWebDraftResumesAtNativeTaskReviewAndExploreCompletesWithoutSending() async throws {
    let remote = OnboardingHTTPFixture()
    var draft = OnboardingDraft()
    draft.step = .skills
    draft.answers.industry = "research"
    draft.answers.provider = "codex"
    _ = try await remote.service.save(draft)
    let store = remote.makeStore()
    defer { store.close() }
    await store.prepare()
    XCTAssertEqual(store.step, .ready)
    await store.refreshReady()
    XCTAssertFalse(store.draft.answers.startingPromptDraft.isEmpty)
    await store.next(skip: true)
    XCTAssertNil(store.snapshot.error)
    let status = try await remote.service.status()
    XCTAssertFalse(status.needsOnboarding)
    XCTAssertTrue(remote.state.value.withLock { $0.messages.isEmpty })
  }

  func testLostCompletionResponseRecoversAfterTheServerDeletedTheDraft() async throws {
    let remote = OnboardingHTTPFixture()
    remote.state.value.withLock { $0.loseCompletionResponse = true }
    var draft = OnboardingDraft()
    draft.step = .ready
    draft.answers.industry = "marketing"
    draft.answers.startingPromptDraft = "Draft a product launch brief"
    _ = try await remote.service.save(draft)
    let opened = Mutex<String?>(nil)
    let store = remote.makeStore { thread in opened.withLock { $0 = thread } }
    defer { store.close() }
    await store.prepare()
    await store.next()
    XCTAssertNotNil(store.snapshot.error)
    XCTAssertNil(opened.withLock { $0 })
    await store.next()
    XCTAssertNil(store.snapshot.error)
    XCTAssertNotNil(opened.withLock { $0 })
    let saved = try await remote.service.draft()
    XCTAssertNil(saved)
    XCTAssertEqual(
      remote.state.value.withLock { $0.messages.values.map(\.prompt) },
      ["Draft a product launch brief"])
  }

  func testLostSendResponseRetriesTheSameMessageAndPreservesTheReviewedTask() async throws {
    let remote = OnboardingHTTPFixture()
    remote.state.value.withLock { $0.loseSendResponse = true }
    let store = remote.makeStore()
    defer { store.close() }
    await store.prepare()
    store.selectIndustry("marketing")
    await store.next()
    await store.next(skip: true)
    store.editPrompt("Draft a launch brief")
    await store.next()
    XCTAssertNotNil(store.snapshot.error)
    let status = try await remote.service.status()
    XCTAssertTrue(status.needsOnboarding)
    store.editPrompt("A different task")
    await store.next()
    XCTAssertNil(store.snapshot.error)
    let completed = try await remote.service.status()
    XCTAssertFalse(completed.needsOnboarding)
    XCTAssertEqual(
      remote.state.value.withLock { $0.messages.values.map(\.prompt) }, ["Draft a launch brief"])
  }

  func testConflictingDraftDoesNotAdvanceOrDiscardTheMembersSelection() async throws {
    let remote = OnboardingHTTPFixture()
    let store = remote.makeStore()
    defer { store.close() }
    await store.prepare()
    var newerDraft = OnboardingDraft()
    newerDraft.step = .sources
    newerDraft.answers.industry = "software"
    _ = try await remote.service.save(newerDraft)
    store.selectIndustry("design")
    await store.next()
    XCTAssertEqual(store.step, .industry)
    XCTAssertEqual(store.draft.answers.industry, "design")
    XCTAssertTrue(store.snapshot.hasDraftConflict)
    await store.retryPreparation()
    XCTAssertNil(store.snapshot.error)
    XCTAssertEqual(store.step, .sources)
    XCTAssertEqual(store.draft.answers.industry, "software")
  }
}

private final class OnboardingHTTPFixture: Sendable {
  struct Message: Decodable {
    let threadID: String
    let prompt: String
    let eventID: String
    enum CodingKeys: String, CodingKey {
      case threadID = "threadId"
      case prompt
      case eventID = "clientEventId"
    }
  }
  struct State {
    var draft: OnboardingDraft?
    var savedJSON: String?
    var completed = false
    var loseCompletionResponse = false
    var loseSendResponse = false
    var threads = Set<String>()
    var messages: [String: Message] = [:]
  }
  final class StateBox: Sendable { let value = Mutex(State()) }
  let state: StateBox
  let fixture: ChatHTTPFixture
  var service: OnboardingService { OnboardingService(client: fixture.client) }

  init() {
    let state = StateBox()
    self.state = state
    fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      switch (request.httpMethod!, path) {
      case ("GET", "/api/onboarding/status"):
        return ChatHTTPResponse(
          body: state.value.withLock {
            "{\"needsOnboarding\":\(!($0.completed)),\"onboardingComplete\":\($0.completed),\"isAdmin\":false,\"hasOrg\":true,\"nativeOnboardingEnabled\":true}"
          })
      case ("GET", "/api/onboarding/draft"):
        struct Response: Encodable { let draft: OnboardingDraft? }
        return try ChatHTTPResponse(json: Response(draft: state.value.withLock { $0.draft }))
      case ("PUT", "/api/onboarding/draft"):
        let body = try request.onboardingBody()
        let saved = try JSONDecoder().decode(OnboardingDraft.self, from: body)
        return state.value.withLock {
          if saved.revision != $0.draft?.revision {
            return ChatHTTPResponse(
              status: 409, body: "{\"error\":{\"message\":\"Setup changed on another device\"}}")
          }
          var draft = saved
          draft.revision = UUID().uuidString.lowercased()
          $0.draft = draft
          $0.savedJSON = String(data: body, encoding: .utf8)
          return ChatHTTPResponse(body: "{\"revision\":\"\(draft.revision!)\"}")
        }
      case ("POST", "/api/onboarding/complete"):
        return state.value.withLock {
          $0.completed = true
          $0.draft = nil
          if $0.loseCompletionResponse {
            return ChatHTTPResponse(
              status: 503, body: "{\"error\":{\"message\":\"Response lost\"}}")
          }
          return ChatHTTPResponse(body: "{\"onboardingComplete\":true,\"needsOnboarding\":false}")
        }
      case ("GET", "/api/user-model-preference"):
        return ChatHTTPResponse(
          body:
            "{\"selectedModel\":null,\"serviceTier\":null,\"modelSettings\":{},\"selectedImageModel\":null,\"updatedAt\":null}"
        )
      case ("GET", "/api/run-models"): return runModelsResponse()
      case ("GET", "/api/model-catalog"): return modelCatalogResponse()
      case ("POST", "/api/chat-threads"):
        let body =
          try JSONSerialization.jsonObject(with: request.onboardingBody()) as! [String: Any]
        let id = body["clientThreadId"] as! String
        _ = state.value.withLock { $0.threads.insert(id) }
        return ChatHTTPResponse(
          status: 201,
          body:
            "{\"id\":\"\(id)\",\"title\":null,\"createdAt\":\"2026-01-01T00:00:00Z\",\"selectedModel\":null,\"serviceTier\":null}"
        )
      case ("GET", _) where path.hasSuffix("/metadata"):
        let id = String(path.split(separator: "/").dropLast().last!)
        return ChatHTTPResponse(
          body:
            "{\"id\":\"\(id)\",\"title\":null,\"selectedModel\":null,\"cloudBrowserEnabled\":false}"
        )
      case ("POST", "/api/chat/events"):
        let message = try JSONDecoder().decode(Message.self, from: request.onboardingBody())
        return state.value.withLock {
          $0.messages[message.eventID] = message
          if $0.loseSendResponse {
            $0.loseSendResponse = false
            return ChatHTTPResponse(
              status: 503, body: "{\"error\":{\"message\":\"Response lost\"}}")
          }
          return ChatHTTPResponse(body: "{\"threadId\":\"\(message.threadID)\"}")
        }
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor func makeStore(
    completion: @escaping @MainActor (String?) async throws -> Void = { _ in }
  ) -> OnboardingStore {
    OnboardingStore(
      client: fixture.client, webURL: fixture.baseURL, graph: CCState.Store(),
      didFail: { _ in }, didComplete: completion)
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
