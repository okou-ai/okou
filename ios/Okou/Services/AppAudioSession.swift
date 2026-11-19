import AVFoundation
import OSLog

/// The system boundary for the process-wide audio session; tests substitute a recorder.
protocol AudioSessionSystem: Sendable {
  func configure(_ use: AppAudioSession.Use) throws
  func setActive(_ active: Bool) throws
}

struct AppleAudioSessionSystem: AudioSessionSystem {
  func configure(_ use: AppAudioSession.Use) throws {
    let audio = AVAudioSession.sharedInstance()
    switch use {
    case .recording:
      try audio.setCategory(
        .playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
    case .playback:
      // Requested media stays audible in Silent Mode, unlike the default solo-ambient category.
      try audio.setCategory(.playback, mode: .default)
    }
  }

  func setActive(_ active: Bool) throws {
    let audio = AVAudioSession.sharedInstance()
    if active {
      try audio.setActive(true)
    } else {
      // Lets interrupted audio in other apps resume.
      try audio.setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
}

/// AVAudioSession is process-wide and its activation can block. Voice capture and media
/// playback each hold at most one claim through this owner, which serializes that work off
/// the UI actor. Recording keeps the microphone configuration while both are held, a retired
/// claim cannot release a newer one, and the session deactivates after the last claim ends.
actor AppAudioSession {
  enum Use: Sendable { case recording, playback }

  static let shared = AppAudioSession(system: AppleAudioSessionSystem())

  private let system: any AudioSessionSystem
  private let log = Logger(subsystem: "ai.okou.ios", category: "Audio")
  private var recording: UUID?
  private var playback: UUID?

  init(system: any AudioSessionSystem) {
    self.system = system
  }

  /// Selects playback for a player that has not started, without interrupting other audio.
  func preparePlayback() throws {
    guard recording == nil else { return }
    try system.configure(.playback)
  }

  func acquire(_ use: Use, owner: UUID) throws {
    let previous = (recording, playback)
    switch use {
    case .recording: recording = owner
    case .playback: playback = owner
    }
    do {
      try system.configure(recording == nil ? .playback : .recording)
      try system.setActive(true)
    } catch {
      (recording, playback) = previous
      let failure = error as NSError
      log.error(
        "event=audio.session.acquire.failed use=\(String(describing: use), privacy: .public) error_domain=\(failure.domain, privacy: .public) error_code=\(failure.code)"
      )
      throw error
    }
  }

  func release(owner: UUID) {
    if recording == owner {
      recording = nil
    } else if playback == owner {
      playback = nil
    } else {
      return
    }
    do {
      if recording == nil, playback == nil {
        try system.setActive(false)
      } else {
        try system.configure(recording == nil ? .playback : .recording)
      }
    } catch {
      let failure = error as NSError
      log.error(
        "event=audio.session.release.failed error_domain=\(failure.domain, privacy: .public) error_code=\(failure.code)"
      )
    }
  }
}
