#if STAGING
  import CCState
  import CCStateSwiftUI
  import ChatData
  import ChatDomain
  import SwiftUI

  /// Supplies an isolated conversation to the production chat detail for on-device acceptance.
  struct CreditUsageDevicePreview: View {
    @State private var sample = Result { try CreditUsageDeviceSample() }

    var body: some View {
      switch sample {
      case .success(let sample):
        StoreProvider(sample.conversation.graph) {
          NavigationStack {
            ChatDetailView(conversation: sample.conversation, topContentInset: 52)
              .background(OkouColor.background)
              .navigationTitle(Text(verbatim: sample.conversation.thread.title ?? ""))
              .navigationBarTitleDisplayMode(.inline)
          }
        }
      case .failure(let error):
        Text(verbatim: error.localizedDescription)
      }
    }
  }

  @MainActor private final class CreditUsageDeviceSample {
    let conversation: ConversationStore

    init() throws {
      guard let origin = URL(string: "https://credits-preview.invalid") else {
        throw APIClientError.invalidURL
      }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [CreditUsageDeviceTransport.self]
      let client = APIClient(
        baseURL: origin, clientVersion: "1.0.0", session: URLSession(configuration: configuration)
      ) { "local-preview" }
      let sync = ChatSync(client: client)
      let thread = ChatThread(
        id: CreditUsageDeviceTransport.threadID, title: "会议准备", createdAt: .now, updatedAt: .now,
        sortAt: .now, pinnedAt: nil, pinOrder: nil)
      conversation = ConversationStore(
        thread: thread, sync: sync, commands: ChatCommands(client: client, sync: sync),
        graph: CCState.Store(), webURL: origin,
        messageMarkdown: MessageMarkdownCache(baseURL: origin),
        isVisible: { true }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
    }
  }

  private final class CreditUsageDeviceTransport: URLProtocol, @unchecked Sendable {
    static let threadID = "8c110000-0000-4000-8000-000000000001"
    static let runID = "8c110000-0000-4000-8000-000000000002"
    static let time = "2026-11-26T03:00:00Z"

    override static func canInit(with request: URLRequest) -> Bool {
      request.url?.host() == "credits-preview.invalid"
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      guard let url = request.url else { return }
      let path = "/api/chat-threads/" + Self.threadID
      let body: [String: Any]
      var status = 200
      switch url.path {
      case path + "/event-snapshot":
        status = 404
        body = ["error": ["code": "CHAT_EVENT_SNAPSHOT_NOT_FOUND", "message": "No snapshot"]]
      case path + "/event-rows":
        let cursor =
          URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
          .first { $0.name == "sinceSeqId" }.flatMap { Int($0.value ?? "") } ?? 0
        let rows = Self.rows
        body = [
          "rows": Array(rows.dropFirst(cursor)), "hasMore": false,
          "cursor": ["lastEventId": Self.eventID(rows.count), "lastSeqId": rows.count]
        ]
      case path + "/usage":
        body = ["runs": [["runId": Self.runID, "usage": Self.receipt]]]
      case path: body = ["cancellationRecoveryPending": false, "lastReadAt": Self.time]
      case path + "/mark-read": body = ["lastReadAt": Self.time]
      case path + "/activity-summary":
        body = ["runId": Self.runID, "status": "ineligible", "messages": []]
      case "/api/connector-accounts/connections":
        body = ["connections": [], "nextCursor": NSNull(), "defaultConnection": NSNull()]
      case path + "/connector-selections": body = ["selections": []]
      default:
        status = 404
        body = ["error": ["code": "NOT_FOUND", "message": "Outside the device preview"]]
      }
      guard
        let response = HTTPURLResponse(
          url: url, statusCode: status, httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/json"])
      else { return }
      do {
        let data = try JSONSerialization.data(withJSONObject: body)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
      } catch {
        client?.urlProtocol(self, didFailWithError: error)
      }
    }

    override func stopLoading() {}

    private static var receipt: [String: Any] {
      [
        "version": 1, "totalCredits": 211, "settledAt": time,
        "breakdown": [
          [
            "kind": "model", "credits": 211,
            "providers": [["provider": "auto", "credits": 211]]
          ]
        ]
      ]
    }

    private static func eventID(_ index: Int) -> String {
      String(format: "8c110001-0000-4000-8000-%012d", index)
    }

    private static var rows: [[String: Any]] {
      let answer = """
        **把这 30 分钟留给一个要做的决定。** 会前把背景材料发给大家，会上就能直接讨论分歧。

        **前 5 分钟 · 对齐目标**
        用一句话说明今天要决定什么，再确认有哪些约束。

        **中间 20 分钟 · 比较方案**
        让每个方案的负责人用同一组标准说明取舍，把时间留给有分歧的问题。

        **最后 5 分钟 · 确认下一步**
        读一遍最终决定，记下负责人和交付日期，把仍需验证的问题留到会后跟进。
        """
      let events: [(String, [String: Any])] = [
        (
          "input.prompt",
          [
            "userMessage": [
              "version": 1,
              "parts": [
                ["type": "text", "text": "明天有 30 分钟的项目评审，时间怎么安排比较好？"]
              ]
            ]
          ]
        ),
        ("output.message", ["content": answer]), ("run.completed", [:]),
        ("usage.recorded", ["usage": receipt])
      ]
      return events.enumerated().map { index, event in
        [
          "id": eventID(index + 1), "chatThreadId": threadID, "seqId": index + 1,
          "eventType": event.0, "runId": runID, "createdAt": time, "payload": event.1
        ]
      }
    }
  }
#endif
