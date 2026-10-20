import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

private let fileID = "41000000-0000-4000-8000-000000000001"
private let agentID = "41000000-0000-4000-8000-000000000002"
private let threadID = "41000000-0000-4000-8000-000000000003"

@MainActor
final class ChatAttachmentTests: XCTestCase {
  func testDirectUploadKeepsCredentialsOnAPIAndFinalizesBeforeSendingFileOnlyMessage() async throws
  {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data("invoice".utf8).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    let paths = Mutex<[String]>([])
    let sent = Mutex<Data?>(nil)
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      paths.withLock { $0.append(path) }
      switch path {
      case "/api/uploads/prepare":
        let body = try JSONDecoder().decode(Prepare.self, from: chatRequestBody(request))
        XCTAssertEqual(body.filename, "invoice.pdf")
        XCTAssertEqual(body.size, 7)
        XCTAssertNil(body.multipart)
        XCTAssertNotNil(request.value(forHTTPHeaderField: "Authorization"))
        return preparedUpload(request: request)
      case "/storage/file":
        XCTAssertEqual(chatRequestBody(request), Data("invoice".utf8))
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Type"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Session-Id"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-amz-meta-owner"), "signed-owner")
        return ChatHTTPResponse(status: 200, body: "")
      case "/api/uploads/complete":
        XCTAssertEqual(
          try JSONDecoder().decode(
            [String: String].self,
            from: chatRequestBody(request))["id"], fileID)
        return completedUpload()
      case let path where path.hasSuffix("/connector-selections"):
        return ChatHTTPResponse(body: #"{"selections":[],"selectedConnections":[]}"#)
      case let path where path.hasSuffix("/metadata"):
        return ChatHTTPResponse(
          body:
            "{\"id\":\"\(threadID)\",\"agentId\":\"\(agentID)\",\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
        )
      case "/api/chat/events":
        sent.withLock { $0 = chatRequestBody(request) }
        return ChatHTTPResponse(status: 201, body: "{\"threadId\":\"\(threadID)\"}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let attachment = try await commands.uploadAttachment(
      file: file, filename: "invoice.pdf", contentType: "application/pdf")
    let date = Date()
    let thread = ChatThread(
      id: threadID, agentID: agentID, title: "Invoice",
      createdAt: date, updatedAt: date, sortAt: date)
    _ = try await commands.send(thread: thread, text: "   ", attachments: [attachment])
    let message = try JSONDecoder().decode(SentMessage.self, from: XCTUnwrap(sent.withLock { $0 }))
    XCTAssertEqual(message.prompt, "(see attached files)")
    XCTAssertFalse(message.hasTextContent)
    XCTAssertEqual(message.userMessage.parts.count, 1)
    XCTAssertEqual(message.userMessage.parts.first?.fileId, fileID)
    XCTAssertEqual(message.userMessage.parts.first?.filenameSnapshot, "invoice.pdf")
    _ = try await commands.send(thread: thread, text: "Please read this", attachments: [attachment])
    let mixed = try JSONDecoder().decode(SentMessage.self, from: XCTUnwrap(sent.withLock { $0 }))
    XCTAssertTrue(mixed.hasTextContent)
    XCTAssertEqual(mixed.prompt, "Please read this")
    XCTAssertEqual(mixed.userMessage.parts.count, 2)
    XCTAssertEqual(mixed.userMessage.parts.first?.text, "Please read this")
    XCTAssertEqual(mixed.userMessage.parts.last?.fileId, fileID)
    XCTAssertEqual(
      Array(paths.withLock { $0 }.prefix(3)),
      ["/api/uploads/prepare", "/storage/file", "/api/uploads/complete"])
  }

  func testMultipartFailureAbortsAndExplicitRetryUploadsAllPartsBeforeCompletion() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data(repeating: 42, count: 5 * 1024 * 1024 + 1).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    let paths = Mutex<[String]>([])
    let shouldFail = Mutex(true)
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      paths.withLock { $0.append(path) }
      switch path {
      case "/api/uploads/prepare":
        let body = try JSONDecoder().decode(Prepare.self, from: chatRequestBody(request))
        XCTAssertEqual(body.multipart, true)
        return preparedUpload(request: request, multipart: true)
      case "/storage/1":
        XCTAssertEqual(chatRequestBody(request), Data(repeating: 42, count: 5 * 1024 * 1024))
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        if shouldFail.withLock({ $0 }) { return ChatHTTPResponse(status: 500, body: "") }
        return ChatHTTPResponse(status: 200, body: "")
      case "/storage/2":
        XCTAssertEqual(chatRequestBody(request), Data([42]))
        return ChatHTTPResponse(status: 200, body: "")
      case "/api/uploads/multipart/abort": return ChatHTTPResponse(body: "{\"id\":\"\(fileID)\"}")
      case "/api/uploads/multipart/complete":
        let body = try JSONDecoder().decode(CompletedParts.self, from: chatRequestBody(request))
        XCTAssertEqual(body.partCount, 2)
        XCTAssertEqual(body.uploadId, "multipart-identity")
        return ChatHTTPResponse(body: "{\"id\":\"\(fileID)\",\"url\":\"artifact://\(fileID)\"}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    do {
      _ = try await commands.uploadAttachment(
        file: file, filename: "movie.mov", contentType: "video/quicktime")
      XCTFail("Failed storage writes must not produce a ready attachment")
    } catch {
      guard case APIClientError.uploadFailed(status: 500) = error else { throw error }
    }
    XCTAssertEqual(
      paths.withLock { $0 },
      ["/api/uploads/prepare", "/storage/1", "/api/uploads/multipart/abort"])
    shouldFail.withLock { $0 = false }
    paths.withLock { $0 = [] }
    let attachment = try await commands.uploadAttachment(
      file: file, filename: "movie.mov", contentType: "video/quicktime")
    XCTAssertEqual(attachment.id, fileID)
    XCTAssertEqual(
      paths.withLock { $0 },
      ["/api/uploads/prepare", "/storage/1", "/storage/2", "/api/uploads/multipart/complete"])
    XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
  }

  func testCancellingMultipartUploadAbortsWithoutFinalizing() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data(repeating: 0, count: 5 * 1024 * 1024 + 1).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    let started = expectation(description: "Multipart transfer started")
    let aborted = expectation(description: "Multipart transfer aborted")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/uploads/prepare": return preparedUpload(request: request, multipart: true)
      case "/storage/1":
        started.fulfill()
        for await _ in stream { break }
        return ChatHTTPResponse(status: 200, body: "")
      case "/api/uploads/multipart/abort":
        aborted.fulfill()
        return ChatHTTPResponse(body: "{\"id\":\"\(fileID)\"}")
      default:
        XCTFail("Cancelled uploads must not be finalized")
        throw URLError(.unsupportedURL)
      }
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let upload = Task {
      try await commands.uploadAttachment(
        file: file, filename: "movie.mov", contentType: "video/quicktime")
    }
    await fulfillment(of: [started], timeout: 3)
    upload.cancel()
    do {
      _ = try await upload.value
      XCTFail("Cancellation must propagate")
    } catch {
      XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
    }
    await fulfillment(of: [aborted], timeout: 3)
  }

  func testOversizedFileIsRejectedBeforeAllocatingStorage() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: nil))
    defer { try? FileManager.default.removeItem(at: file) }
    let handle = try FileHandle(forWritingTo: file)
    try handle.truncate(atOffset: UInt64(ChatAttachment.maximumSize + 1))
    try handle.close()
    let fixture = ChatHTTPFixture { _ in
      XCTFail("Oversized files must not allocate remote storage")
      throw URLError(.unsupportedURL)
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    do {
      _ = try await commands.uploadAttachment(
        file: file, filename: "large.zip", contentType: "application/zip")
      XCTFail("Oversized files must be rejected")
    } catch { XCTAssertTrue(error.localizedDescription.contains("1 GB")) }
  }
}

private struct Prepare: Decodable {
  let filename: String
  let size: Int
  let multipart: Bool?
}
private struct CompletedParts: Decodable {
  let partCount: Int
  let uploadId: String
}
private struct SentMessage: Decodable {
  let prompt: String
  let hasTextContent: Bool
  let userMessage: Document
  struct Document: Decodable {
    let parts: [Part]
    struct Part: Decodable {
      let type: String
      let fileId: String?
      let filenameSnapshot: String?
      let text: String?
    }
  }
}

private func preparedUpload(request: URLRequest, multipart: Bool = false) -> ChatHTTPResponse {
  let origin = "https://\(request.url!.host!)"
  let transfer =
    multipart
    ? "\"multipart\":{\"uploadId\":\"multipart-identity\",\"partSize\":5242880,\"parts\":[{\"partNumber\":1,\"uploadUrl\":\"\(origin)/storage/1\"},{\"partNumber\":2,\"uploadUrl\":\"\(origin)/storage/2\"}]}"
    : "\"uploadUrl\":\"\(origin)/storage/file\",\"uploadHeaders\":{\"x-amz-meta-owner\":\"signed-owner\"}"
  return ChatHTTPResponse(
    body:
      "{\"id\":\"\(fileID)\",\"filename\":\"invoice.pdf\",\"contentType\":\"application/pdf\",\"size\":7,\"url\":\"artifact://\(fileID)\",\(transfer)}"
  )
}

private func completedUpload() -> ChatHTTPResponse {
  ChatHTTPResponse(
    body:
      "{\"id\":\"\(fileID)\",\"filename\":\"invoice.pdf\",\"contentType\":\"application/pdf\",\"size\":7,\"url\":\"artifact://\(fileID)\"}"
  )
}
