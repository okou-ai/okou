import SwiftUI

/// Native geometry is intentionally independent of the Web's pixel/rem scale.
enum OkouSpace {
  static let hairline: CGFloat = 0.5
  static let one: CGFloat = 1
  static let two: CGFloat = 2
  static let three: CGFloat = 3
  static let xs: CGFloat = 4
  static let six: CGFloat = 6
  static let sm: CGFloat = 8
  static let ten: CGFloat = 10
  static let md: CGFloat = 12
  static let lg: CGFloat = 16
  static let xl: CGFloat = 20
  static let xxl: CGFloat = 24
  static let xxxl: CGFloat = 32
  static let section: CGFloat = 40
  static let hero: CGFloat = 48
}

enum OkouRadius {
  /// Web inline code (`.wmde-markdown code`, 4 px).
  static let inline: CGFloat = 4
  static let thumbnail: CGFloat = 6
  static let small: CGFloat = 8
  static let control: CGFloat = 14
  static let chat: CGFloat = 16
  static let card: CGFloat = 20
  static let sheet: CGFloat = 28
}

enum OkouControl {
  /// Minimum interactive area; small artwork may sit inside this area.
  static let minimumTarget: CGFloat = 44
  static let largeHeight: CGFloat = 52
  static let pageInset: CGFloat = 24
  static let readableWidth: CGFloat = 440
  /// Chat rows in the sidebar.
  static let listRow: CGFloat = 48
  /// A row in a grouped card (Settings and every sheet): the height the system gives a row
  /// with a 28 pt icon slot or a switch, so a row of text alone is no shorter beside it.
  static let groupedRow: CGFloat = 52
  /// Quiet icon actions inside content (message actions, row shortcuts); still a 44 pt wide target.
  static let inlineActionHeight: CGFloat = 36
  /// The slim header of a code block (language and copy).
  static let codeHeaderHeight: CGFloat = 32
  /// Centre-to-centre spacing of the icon actions under an answer (web: 28 px buttons, 4 px gap;
  /// ChatGPT: 31 pt).
  static let messageActionPitch: CGFloat = 32
  /// Unread marker on a chat row (web: 8 px `sky-600`).
  static let unreadDot: CGFloat = 8
  /// The leading slot that holds a chat's status emoji in a list section.
  static let statusColumn: CGFloat = 22
  /// The leading slot of a grouped-list row (`OkouRowLabel`): icons, logos and avatars all
  /// centre in it, so every row's text starts on the same edge.
  static let rowLeadingSlot: CGFloat = 28
  /// Capacity bars (usage allowances).
  static let meterHeight: CGFloat = 6
  /// Live dictation waveform: bar width, gap between bars, and the strip's height.
  static let waveformBar: CGFloat = 3
  static let waveformGap: CGFloat = 2
  static let waveformHeight: CGFloat = 28
  /// The soft circle behind an empty state's glyph, and the empty state's text width.
  static let emptyStateMark: CGFloat = 52
  static let emptyStateWidth: CGFloat = 300
  /// Filter chips in a sideways row.
  static let chipHeight: CGFloat = 36
  /// A page-level segment control's track, the large segmented control's height.
  static let segmentHeight: CGFloat = 48
  /// Catalog logo tiles: on a card, and at the top of an item's detail.
  static let logoTile: CGFloat = 44
  static let logoTileLarge: CGFloat = 64
  /// The image or video preview at the top of a file or result card in the transcript.
  static let cardMediaHeight: CGFloat = 180
  /// A picture in the transcript is a fixed tile, as the web's Markdown image (200 × 180).
  static let mediaTileWidth: CGFloat = 200
  /// A result card (website, slides, document): at most the web's 400 pt, with one 16:9
  /// cover under its heading for every kind, so results in a chat line up.
  static let resultWidth: CGFloat = 400
  static let coverAspect: CGFloat = 16.0 / 9.0
  /// The "+" or chevron on a catalog card, inside a 44 pt target.
  static let addControl: CGFloat = 32
  /// A tile in a sideways media strip (Camera, a recent photo), and the pick mark on a photo.
  static let mediaTile: CGFloat = 88
  static let selectionMark: CGFloat = 22
  static let selectionMarkStroke: CGFloat = 1.5
  /// A loading chat's placeholder user bubble and text line (the web's h-10 and h-4).
  static let skeletonBubble: CGFloat = 40
  static let skeletonLine: CGFloat = 16
  /// The two placeholder exchanges' height.
  static let skeletonHeight: CGFloat = 360
}

enum OkouIconSize {
  /// A sign-in provider's own mark (Google, Microsoft, Slack, Apple) in its button.
  static let providerMark: CGFloat = 20
  static let inline: CGFloat = 16
  static let menu: CGFloat = 20
  static let standard: CGFloat = 20
  static let large: CGFloat = 24
  static let toolbar: CGFloat = 20
  static let badge: CGFloat = 14
  static let accessory: CGFloat = 16
  static let reference: CGFloat = 16
  static let mediaOverlay: CGFloat = 32
  static let filePreview: CGFloat = 48
  static let emptyState: CGFloat = 24
  /// The breathing running dot; it scales with Dynamic Type from this base.
  static let runningIndicator: CGFloat = 14
  /// Partner logos (connector catalog) in a square slot.
  static let partnerLogo: CGFloat = 24
  static let partnerLogoLarge: CGFloat = 36
}

enum OkouAvatarSize {
  static let workspace: CGFloat = 32
  static let message: CGFloat = 28
  static let sidebar: CGFloat = 32
  static let greeting: CGFloat = 56
  /// An agent in a chat row's status column (Active): its mark is the size of a status emoji.
  static let row: CGFloat = 28
  /// The account and the workspace at the top of Settings: one size, the height of the
  /// account row's two lines.
  static let account: CGFloat = 40
  /// A workspace in the workspace menu, beside its name.
  static let menu: CGFloat = 28
  /// A logo inside a 44 pt glass circle (the sidebar's workspace button), with 8 pt of glass
  /// around it.
  static let glassControl: CGFloat = 28
}

enum OkouMotion {
  static let press = Animation.easeOut(duration: 0.15)
  static let transition = Animation.easeInOut(duration: 0.25)
  /// The navigation bar changing height (the search field rising into it), as UIKit moves it;
  /// a page under the bar follows in this time (`OkouUnderNavigationBar`).
  static let barMove: TimeInterval = 0.35

  /// Web `chat-greeting-token`: each word fades in from an 8 pt blur and a 14 pt rise.
  static let greetingWord = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.72)
  static let greetingWordStep: Double = 0.07
  static let greetingWordRise: CGFloat = 14
  static let greetingWordBlur: CGFloat = 8
  /// One dictation level sample; the waveform scrolls one bar per sample.
  static let waveformSample: TimeInterval = 0.05
  /// How far left the sidebar starts as it slides in, as a share of its width.
  static let sidebarParallax: CGFloat = 0.25
  /// How much of the screen each page's leading edge fades over while the sidebar moves.
  static let sidebarFeather: CGFloat = 0.35
  /// A skeleton's shimmer: one sweep of the light across the group, the band's width as a
  /// share of the group's, how much it lifts the grey, and its slant.
  static let shimmer: Double = 1.6
  static let shimmerBand: CGFloat = 0.4
  static let shimmerStrength: Double = 0.6
  static let shimmerSlant: Double = 12
  /// The web's `okou-skeleton-pulse`, a skeleton's motion under Reduce Motion: one breath, and
  /// how far it dims.
  static let skeletonPulse: Double = 2
  static let skeletonDim: Double = 0.7
  /// Web `--duration-running-indicator`; list rows trail by 1/12 of a cycle each.
  static let runningCycle: Double = 2.4
  static let runningWaveRows: Double = 12
  /// Streamed text is published at most this often so a row is not re-measured per chunk.
  static let streamFlush = Duration.milliseconds(120)
  /// Routine sync finishes sooner; only a slow sync shows its banner.
  static let syncBannerDelay = Duration.milliseconds(2500)
  /// How long a "Copied" check replaces the copy glyph.
  static let confirmation = Duration.seconds(1.5)
}

/// Shadows are reserved for surfaces that float over content.
enum OkouElevation {
  /// The chat behind the open sidebar blurs to this radius as the list slides in.
  static let sidebarBlur: CGFloat = 12
  /// Suggestion panels above the composer (slash workflows, @mentions).
  static let floatingRadius: CGFloat = 16
  static let floatingY: CGFloat = 6
  static let floatingOpacity: Double = 0.08
  /// The selected segment's lift off its track (the web's `--segment-selected-shadow`).
  static let segmentRadius: CGFloat = 1.5
  static let segmentY: CGFloat = 1
  static let segmentOpacity: Double = 0.08
}
