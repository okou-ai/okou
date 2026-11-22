import Foundation
import Synchronization
import XCTest

@testable import Okou

final class AppAudioSessionTests: XCTestCase {

  func testPlaybackIsSelectedBeforeStartAndReleasedToOtherAudioAfterward() async throws {
    let system = AudioSessionRecorder()
    let session = AppAudioSession(system: system)
    let playback = UUID()

    try await session.preparePlayback()
    XCTAssertEqual(system.state, .init(use: .playback, active: false))
    try await session.acquire(.playback, owner: playback)
    XCTAssertEqual(system.state, .init(use: .playback, active: true))
    await session.release(owner: playback)
    XCTAssertEqual(system.state, .init(use: .playback, active: false))
  }

  func testRecordingKeepsMicrophoneUntilItsCurrentClaimEndsWhilePlaybackContinues() async throws {
    let system = AudioSessionRecorder()
    let session = AppAudioSession(system: system)
    let retired = UUID()
    let recording = UUID()
    let playback = UUID()

    try await session.acquire(.recording, owner: retired)
    try await session.acquire(.recording, owner: recording)
    try await session.preparePlayback()
    try await session.acquire(.playback, owner: playback)
    await session.release(owner: retired)
    XCTAssertEqual(system.state, .init(use: .recording, active: true))
    await session.release(owner: recording)
    XCTAssertEqual(system.state, .init(use: .playback, active: true))
    await session.release(owner: playback)
    XCTAssertEqual(system.state, .init(use: .playback, active: false))
  }

  func testFailedPlaybackActivationLeavesRecordingClaimInPlace() async throws {
    let system = AudioSessionRecorder()
    let session = AppAudioSession(system: system)
    let recording = UUID()
    let playback = UUID()
    try await session.acquire(.recording, owner: recording)
    system.failsActivation = true

    do {
      try await session.acquire(.playback, owner: playback)
      XCTFail("Expected playback activation to fail")
    } catch {
      XCTAssertEqual((error as NSError).code, AudioSessionRecorder.activationFailure)
    }
    system.failsActivation = false
    await session.release(owner: playback)
    XCTAssertEqual(system.state, .init(use: .recording, active: true))
    await session.release(owner: recording)
    XCTAssertEqual(system.state, .init(use: .recording, active: false))
  }
}

/// Records the session the system would apply; activation can fail like a higher-priority call.
private final class AudioSessionRecorder: AudioSessionSystem {
  struct State: Equatable {
    var use: AppAudioSession.Use?
    var active = false
  }

  static let activationFailure = 560_557_684
  private let current = Mutex(State())
  private let failure = Mutex(false)

  var state: State { current.withLock { $0 } }
  var failsActivation: Bool {
    get { failure.withLock { $0 } }
    set { failure.withLock { $0 = newValue } }
  }

  func configure(_ use: AppAudioSession.Use) throws {
    current.withLock { $0.use = use }
  }

  func setActive(_ active: Bool) throws {
    if active, failsActivation {
      throw NSError(domain: NSOSStatusErrorDomain, code: Self.activationFailure)
    }
    current.withLock { $0.active = active }
  }
}
