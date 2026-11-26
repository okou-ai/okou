import AVFoundation
import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class UserMessageVoiceTests: XCTestCase {
  func testTappingOneInlineRecordingPlaysAllOfItsFilesInOrder() async throws {
    let recording = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "voice-speech", withExtension: "wav"))
    let directory = CacheTestDirectory(owner: self).url
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    for id in ["first", "second", "other"] {
      try FileManager.default.copyItem(at: recording, to: directory.appending(path: id + ".wav"))
    }
    let http = ChatHTTPFixture { request in
      guard let url = request.url, url.path == "/api/web/file-url",
        let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
          .first(where: { $0.name == "file_id" })?.value
      else { throw URLError(.unsupportedURL) }
      let source = directory.appending(path: id + ".wav").absoluteString
      return try ChatHTTPResponse(json: ["url": source, "downloadUrl": source])
    }
    let commands = ChatCommands(client: http.client, sync: ChatSync(client: http.client))
    let viewer = MessageAttachmentStore(commands: commands, graph: makeTestWorkspaceGraph()) { _ in
    }
    let playback = VoiceClipPlayback(artifacts: commands.artifacts)
    defer {
      playback.stop()
      viewer.close()
      commands.closeFileCache()
    }
    let message = try sentMessage(
      #"""
      {"type":"text","text":"早 "},
      {"type":"voice","clips":[{"fileId":"first"},{"fileId":"second"}]},
      {"type":"text","text":" https://example.com "},{"type":"voice","clips":[{"fileId":"other"}]},
      {"type":"text","text":" 好"}
      """#)
    let host = UIHostingController(
      rootView: UserMessageView(
        message: message, webURL: http.baseURL, viewer: viewer, loadsAttachments: true,
        voicePlayback: playback
      ) { EmptyView() })
    let window = try await mountNativeHost(host) { window in
      let controls = nativeViews(in: window).compactMap { $0 as? VoiceClipControl }
      return controls.count == 2 && controls.allSatisfy { $0.duration != nil && !$0.isHidden }
    }
    defer { unmount(window) }
    let views = nativeViews(in: window)
    let text = try XCTUnwrap(views.compactMap { $0 as? UITextView }.first?.attributedText)
    XCTAssertEqual(text.string, "早 \u{fffc} https://example.com \u{fffc} 好")
    let link = (text.string as NSString).range(of: "https://example.com")
    XCTAssertEqual(
      text.attribute(.link, at: link.location, effectiveRange: nil) as? URL,
      URL(string: "https://example.com"))
    let controls = views.compactMap { $0 as? VoiceClipControl }
    let clip = try XCTUnwrap(controls.first { $0.fileIDs == ["first", "second"] })
    XCTAssertEqual(try XCTUnwrap(clip.duration), 2, accuracy: 0.01)
    let hit = window.hitTest(
      clip.convert(CGPoint(x: clip.bounds.midX, y: clip.bounds.midY), to: window), with: nil)
    XCTAssertTrue(hit === clip)
    let ends = ["first", "second"].map { id in
      expectation(forNotification: AVPlayerItem.didPlayToEndTimeNotification, object: nil) { note in
        let asset = (note.object as? AVPlayerItem)?.asset as? AVURLAsset
        return asset?.url.lastPathComponent == id + ".wav"
      }
    }
    clip.sendActions(for: .touchUpInside)
    await fulfillment(of: ends, timeout: 8, enforceOrder: true)
  }

  func testRecordingsWithoutWrittenTextUseOnePlayerWithOrWithoutAnUploadedFile() async throws {
    let http = ChatHTTPFixture { _ in throw URLError(.unsupportedURL) }
    let commands = ChatCommands(client: http.client, sync: ChatSync(client: http.client))
    let viewer = MessageAttachmentStore(commands: commands, graph: makeTestWorkspaceGraph()) { _ in
    }
    let playback = VoiceClipPlayback(artifacts: commands.artifacts)
    defer {
      viewer.close()
      commands.closeFileCache()
    }
    let recordings = #"""
      {"type":"voice","clips":[{"fileId":"a"}]},{"type":"voice","clips":[{"fileId":"b"}]}
      """#
    let file =
      #"{"type":"file","fileId":"upload","filenameSnapshot":"Imported.m4a","contentType":"audio/mp4"}"#
    let messages = try [recordings, recordings + "," + file].map { try sentMessage($0) }
    let host = UIHostingController(
      rootView: VStack {
        ForEach(Array(messages.enumerated()), id: \.offset) { _, message in
          UserMessageView(
            message: message, webURL: http.baseURL, viewer: viewer,
            loadsAttachments: false, voicePlayback: playback
          ) { EmptyView() }
        }
      })
    let window = try await mountNativeHost(host) { window in
      nativeViews(in: window).compactMap { $0 as? VoiceClipControl }.count == 2
    }
    defer { unmount(window) }
    let players = nativeViews(in: window).compactMap { $0 as? VoiceClipControl }
    XCTAssertEqual(Set(players.map(\.style)), [.full, .compact])
    XCTAssertEqual(players.map(\.fileIDs), [["a", "b"], ["a", "b"]])
  }

  private func sentMessage(_ parts: String) throws -> ChatMessage {
    let data = Data("{\"version\":1,\"parts\":[\(parts)]}".utf8)
    let document = try JSONDecoder().decode(ChatUserMessage.self, from: data)
    return ChatMessage(
      id: "sent", role: .user, text: document.displayText, attachments: try document.attachments(),
      createdAt: .now, isQueued: false, isError: false, userMessage: document)
  }
}
