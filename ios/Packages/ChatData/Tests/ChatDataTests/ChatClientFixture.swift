import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

let fixtureThread = "10000000-0000-4000-8000-000000000001"
let fixtureAgent = "10000000-0000-4000-8000-000000000002"
let fixtureRun = "10000000-0000-4000-8000-000000000003"
let deletedThread = "10000000-0000-4000-8000-000000000004"
let newThread = "10000000-0000-4000-8000-000000000005"
let fixtureDate = "2026-09-17T10:00:00.000Z"

struct CapturedSend: Decodable, Sendable {
  let hasAgentId: Bool
  let prompt: String
  let clientEventId: String
  let cloudBrowserEnabled: Bool
  let hostIsExplicitNull: Bool
  let hasModelOverride: Bool
  enum Keys: String, CodingKey {
    case agentId, prompt, clientEventId, cloudBrowserEnabled, computerUseHostId, model
  }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    hasAgentId = c.contains(.agentId)
    prompt = try c.decode(String.self, forKey: .prompt)
    clientEventId = try c.decode(String.self, forKey: .clientEventId)
    cloudBrowserEnabled = try c.decode(Bool.self, forKey: .cloudBrowserEnabled)
    hostIsExplicitNull =
      try c.contains(.computerUseHostId) && c.decodeNil(forKey: .computerUseHostId)
    hasModelOverride = c.contains(.model)
  }
}

struct CapturedControl: Decodable, Sendable {
  let revokesEventId: String?
  let interruptsRunId: String?
}

func sampleThread() -> ChatThread {
  ChatThread(
    id: fixtureThread, title: "Existing chat",
    selectedModel: "claude-opus-5-5",
    createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0),
    sortAt: Date(timeIntervalSince1970: 0),
    pinnedAt: nil, pinOrder: nil, indicator: nil)
}

func threadJSON(id: String, date: String = fixtureDate) -> String {
  "{\"id\":\"\(id)\",\"title\":\"Original title\",\"sortAt\":\"\(date)\",\"createdAt\":\"\(date)\",\"updatedAt\":\"\(date)\",\"pinnedAt\":null,\"renamedAt\":null,\"selectedModel\":\"gpt-5.6-sol\",\"serviceTier\":null,\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
}

func threadEventJSON(seq: Int, kind: String, thread: String, title: String = "New chat")
  -> String
{
  "{\"id\":\"\(eventIdentity(seq))\",\"seqId\":\(seq),\"kind\":\"\(kind)\",\"chatThreadId\":\"\(thread)\",\"title\":\"\(title)\",\"selectedModel\":\"gpt-5.6-sol\",\"createdAt\":\"\(fixtureDate)\"}"
}

func eventJSON(seq: Int, type: String, run: String? = fixtureRun, payload: String = "null")
  -> String
{
  "{\"id\":\"\(eventIdentity(seq))\",\"chatThreadId\":\"\(fixtureThread)\",\"runId\":\(run.map { "\"\($0)\"" } ?? "null"),\"revokesEventId\":null,\"contextType\":null,\"contextId\":null,\"runEventSequenceNumber\":null,\"runEventId\":null,\"seqId\":\(seq),\"createdAt\":\"\(fixtureDate)\",\"eventType\":\"\(type)\",\"payload\":\(payload)}"
}

func eventIdentity(_ sequence: Int) -> String {
  String(format: "20000000-0000-4000-8000-%012d", sequence)
}

func chatQueryValue(_ name: String, in request: URLRequest) -> String? {
  guard let url = request.url else { return nil }
  return URLComponents(url: url, resolvingAgainstBaseURL: false)?
    .queryItems?.first(where: { $0.name == name })?.value
}

func temporaryChatCacheDirectory() throws -> URL {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("okou-chat-cache-tests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  return directory
}

func userPayload(_ text: String) -> String {
  "{\"userMessage\":{\"version\":1,\"parts\":[{\"type\":\"text\",\"text\":\"\(text)\"}]}}"
}

func metadataJSON(browser: Bool) -> String {
  "{\"id\":\"\(fixtureThread)\",\"title\":\"Existing chat\",\"selectedModel\":\"claude-opus-5-5\",\"modelSettings\":{},\"serviceTier\":null,\"pinnedAt\":null,\"computerUseHostId\":null,\"cloudBrowserEnabled\":\(browser),\"selectedImageModel\":null}"
}
