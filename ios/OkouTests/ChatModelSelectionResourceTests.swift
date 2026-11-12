import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatModelSelectionResourceTests: XCTestCase {
  func testOverlappingPickerReadersShareMetadataAfterOneWaiterIsCancelled() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "The conversation metadata request started")
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/metadata") {
        reads.withLock { $0 += 1 }
        began.fulfill()
        await gate.wait()
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let models = modelStore(fixture)
    let selection = ChatModelSelectionStore(models: models, thread: thread())
    let first = Task.immediate { await selection.open() }
    addTeardownBlock { @MainActor in
      selection.close()
      models.close()
      gate.open()
      first.cancel()
      await first.value
      withExtendedLifetime(fixture) {}
    }
    await fulfillment(of: [began], timeout: 3)
    let second = Task.immediate { await selection.open() }
    let read = try models.stateStore.get(selection.metadataValue)
    let waiter = Task.immediate { try await read.value }
    addTeardownBlock { @MainActor in
      gate.open()
      second.cancel()
      waiter.cancel()
      await second.value
      _ = await waiter.result
    }
    waiter.cancel()
    XCTAssertFalse(selection.canSend)
    gate.open()
    await first.value
    await second.value
    let value = try await read.value
    _ = await waiter.result
    XCTAssertEqual(value?.model, "codex-model")
    XCTAssertEqual(selection.selection.model, "codex-model")
    XCTAssertTrue(selection.canSend)
    XCTAssertEqual(reads.withLock { $0 }, 1)
  }

  func testExplicitRefreshCancelsTheOriginalMetadataAndPublishesTheFreshRead() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "The old metadata response is held")
    let cancelled = expectation(description: "The original metadata HTTP request was cancelled")
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/metadata") {
        let count = reads.withLock {
          $0 += 1
          return $0
        }
        if count == 1 {
          began.fulfill()
          await withTaskCancellationHandler {
            await gate.wait()
          } onCancel: {
            cancelled.fulfill()
          }
        }
        return ChatHTTPResponse(body: count == 1 ? ModelHTTPFixtures.metadata : changedMetadata)
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let models = modelStore(fixture)
    let selection = ChatModelSelectionStore(models: models, thread: thread())
    let initial = Task.immediate { await selection.open() }
    addTeardownBlock { @MainActor in
      selection.close()
      models.close()
      gate.open()
      initial.cancel()
      await initial.value
      withExtendedLifetime(fixture) {}
    }
    await fulfillment(of: [began], timeout: 3)
    await selection.refresh()
    await fulfillment(of: [cancelled], timeout: 3)
    await initial.value
    let value = try await models.stateStore.get(selection.metadataValue).value
    XCTAssertEqual(value?.model, "claude-model")
    XCTAssertEqual(selection.selection.model, "claude-model")
    XCTAssertTrue(selection.canSend)
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  func testClosingAConversationCancelsMetadataWithoutRetiringItsReplacement() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "The retired conversation has pending metadata")
    let cancelled = expectation(description: "Retirement cancelled the original HTTP request")
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/metadata") {
        let count = reads.withLock {
          $0 += 1
          return $0
        }
        if count == 1 {
          began.fulfill()
          await withTaskCancellationHandler {
            await gate.wait()
          } onCancel: {
            cancelled.fulfill()
          }
        }
        return ChatHTTPResponse(body: count == 1 ? ModelHTTPFixtures.metadata : changedMetadata)
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let models = modelStore(fixture)
    let retired = ChatModelSelectionStore(models: models, thread: thread())
    let initial = Task.immediate { await retired.open() }
    addTeardownBlock { @MainActor in
      retired.close()
      models.close()
      gate.open()
      initial.cancel()
      await initial.value
      withExtendedLifetime(fixture) {}
    }
    await fulfillment(of: [began], timeout: 3)
    retired.close()
    await fulfillment(of: [cancelled], timeout: 3)
    await initial.value
    let current = ChatModelSelectionStore(models: models, thread: thread())
    addTeardownBlock { @MainActor in current.close() }
    await current.open()
    XCTAssertFalse(retired.canSend)
    XCTAssertEqual(current.selection.model, "claude-model")
    XCTAssertTrue(current.canSend)
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  func testMetadataFailureRemainsOnTheSharedReadUntilAnExplicitRetryConfirmsSettings() async throws
  {
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/metadata") {
        let count = reads.withLock {
          $0 += 1
          return $0
        }
        if count == 1 {
          return ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Unavailable\"}}")
        }
        return ChatHTTPResponse(body: changedMetadata)
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let models = modelStore(fixture)
    let selection = ChatModelSelectionStore(models: models, thread: thread())
    addTeardownBlock { @MainActor in
      selection.close()
      models.close()
      withExtendedLifetime(fixture) {}
    }
    await selection.open()
    XCTAssertFalse(selection.canSend)
    do {
      _ = try await models.stateStore.get(selection.metadataValue).value
      XCTFail("A second observer must see the original metadata failure")
    } catch {
      XCTAssertEqual((error as? APIClientError)?.statusCode, 403)
    }
    XCTAssertEqual(reads.withLock { $0 }, 1)
    await selection.refresh()
    XCTAssertEqual(selection.selection.model, "claude-model")
    XCTAssertTrue(selection.canSend)
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  func testSavingReadsFreshConfirmationInsteadOfReusingCachedMetadata() async throws {
    let saved = Mutex(false)
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      if path.hasSuffix("/model-selection") {
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        XCTAssertEqual(body["model"] as? String, "claude-model")
        saved.withLock { $0 = true }
        return ChatHTTPResponse(status: 204, body: "")
      }
      if path.hasSuffix("/metadata") {
        reads.withLock { $0 += 1 }
        return ChatHTTPResponse(
          body: saved.withLock { $0 } ? changedMetadata : ModelHTTPFixtures.metadata)
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(path))
    }
    let models = modelStore(fixture)
    let selection = ChatModelSelectionStore(models: models, thread: thread())
    addTeardownBlock { @MainActor in
      selection.close()
      models.close()
      withExtendedLifetime(fixture) {}
    }
    await selection.open()
    let previous = try await models.stateStore.get(selection.metadataValue).value
    XCTAssertEqual(previous?.model, "codex-model")
    let committed = await selection.apply(selection.selection.choosing(model: "claude-model"))
    XCTAssertTrue(committed)
    XCTAssertEqual(selection.selection.model, "claude-model")
    XCTAssertTrue(selection.canSend)
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  private func modelStore(_ fixture: ChatHTTPFixture) -> ChatModelStore {
    ChatModelStore(client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
  }

  private func thread() -> ChatThread {
    ChatThread(
      id: ModelHTTPFixtures.threadID, agentID: ModelHTTPFixtures.agentID,
      title: "Example", selectedModel: "codex-model", createdAt: Date(), updatedAt: Date(),
      sortAt: Date())
  }
}

private let changedMetadata = ModelHTTPFixtures.metadata.replacingOccurrences(
  of: "\"selectedModel\":\"codex-model\"", with: "\"selectedModel\":\"claude-model\"")
