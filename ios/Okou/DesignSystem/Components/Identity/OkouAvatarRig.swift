import SwiftUI

/// The Okou avatar's moods, from Liangyou's "21 种小情绪 · Okou 动态头像" (v27) by way of Web's
/// rig (`okou-avatar-rig.ts`): how long each takes to repeat, and the moment it reads best when
/// it has to stand still.
enum OkouAvatarMood: String, CaseIterable, Identifiable, Sendable {
  case idle, happy, nod, shake, sleepy, surprise, think, shy, laugh, wink, angry, cry, pout
  case confused, sweat, party, cool, please, kiss, dizzy, focus

  var id: String { rawValue }

  /// Seconds before the mood repeats.
  var cycle: Double {
    switch self {
    case .idle: 8
    case .happy, .surprise, .laugh, .party: 4.8
    case .nod: 3.5
    case .shake: 3.6
    case .sleepy: 6.8
    case .think, .confused, .cool: 5
    case .shy: 5.2
    case .wink: 2.83
    case .angry: 2
    case .cry: 4.6
    case .pout: 4
    case .sweat, .please, .kiss, .dizzy: 3
    case .focus: 6
    }
  }

  /// The still frame: the mood's most readable moment, for Reduce Motion and still avatars.
  var hero: Double {
    switch self {
    case .idle, .surprise: 1.2
    case .happy: 0.6
    case .nod, .dizzy: 0.9
    case .shake: 1.5
    case .sleepy: 3.3
    case .think: 1.4
    case .shy: 1.3
    case .laugh: 0.55
    case .wink: 0.8
    case .angry: 0.5
    case .cry, .please: 0.75
    case .pout, .sweat, .focus: 1
    case .confused, .cool: 1.25
    case .party: 1.1
    case .kiss: 1.2
    }
  }
}

/// One drawn moment of the rig: what it moves, fades and reshapes, by node id.
struct OkouAvatarFrame {
  var transforms: [String: CGAffineTransform] = [:]
  var opacities: [String: Double] = [:]
  var paths: [String: Path] = [:]
  /// Whether the torso keeps its clip; a party hop lifts the figure clear of it.
  var torsoClipped = true
}

/// Web's rig as pure functions: a frame is a function of (mood, time), so a still frame is
/// reproducible and every avatar on screen agrees on what a mood looks like.
enum OkouAvatarRig {
  private typealias Art = OkouAvatarArtwork

  static func frame(_ mood: OkouAvatarMood, at time: Double) -> OkouAvatarFrame {
    var writer = Writer(mood: mood, time: time)
    writer.drawBody()
    for side in OkouAvatarSide.allCases { writer.drawEye(side) }
    writer.drawFace()
    writer.drawMouth()
    writer.drawHair()
    writer.drawSleepAndThought()
    writer.drawTearsAndSweat()
    writer.drawHeartsAndAnger()
    writer.drawConfetti()
    writer.drawDizzyAndFocus()
    return writer.frame
  }

  // MARK: - Poses (unchanged from Web)

  struct Pose {
    var x = 0.0, y = 0.0, r = 0.0, sx = 1.0, sy = 1.0, fx = 0.0, fy = 0.0, gx = 0.0, gy = 0.0
    var ex = 1.0, ey = 1.0, happy = 0.0, wink = 0.0, blush = 0.0, o = 0.0, brow = 0.0
    var asym = 0.0, sleep = 0.0, think = 0.0, stars = 0.0, mouthHappy = 0.0, mouthSleep = 0.0
    var mouthShy = 0.0, frown = 0.0, flat = 0.0, laugh = 0.0, joy = 0.0, chuckle = 0.0
    var kiss = 0.0, squeeze = 0.0, spiral = 0.0, starEyes = 0.0, anger = 0.0, sad = 0.0
    var tears = 0.0, weeping = 0.0, sob = 0.0, sweat = 0.0, hearts = 0.0, glasses = 0.0
    var question = 0.0, confetti = 0.0, celebrate = 0.0, hop = 0.0, dizzy = 0.0, focus = 0.0
    var plead = 0.0
  }

  static func pose(_ mood: OkouAvatarMood, at t: Double) -> Pose {
    var p = Pose()
    let a = t * .pi * 2
    p.y = -1.3 + sin(a / 4) * 1.3
    switch mood {
    case .idle:
      p.r = sin(a / 8) * 3.3
      p.fx = sin(a / 8) * 1.5
    case .happy:
      let b = sin(a / 2.4)
      p.y = -3 - max(0, b) * 8
      p.r = sin(a / 4.8) * 3.5
      p.sy = 1 + 0.012 * b
      p.sx = 1 - 0.007 * b
      p.happy = 0.98
      p.blush = 0.48
      p.mouthHappy = 1
      p.stars = 0.8
    case .nod:
      let n = pulse(mod(t, 3.5), 0.9, 0.36) + pulse(mod(t, 3.5), 1.7, 0.36)
      p.y = 9 * n
      p.sy = 1 - 0.087 * n
      p.sx = 1 + 0.012 * n
      p.fy = 5 * n
      p.gy = 6 * n
      p.mouthHappy = 0.18
      p.brow = 0.12
    case .shake:
      let v = mod(t, 3.6)
      let w = sin(v * .pi * 2 / 1.2) * pow(sin(.pi * v / 3.6), 2)
      p.x = 8 * w
      p.r = 7.5 * w
      p.sx = 1 - 0.035 * abs(w)
      p.fx = 7 * w
      p.gx = 3 * w
      p.brow = 0.42
      p.asym = -0.3
      p.mouthShy = 0.35
    case .sleepy:
      let d = pulse(mod(t, 6.8), 3.3, 1.5)
      p.r = 6.5 + sin(a / 6.8) * 1.8
      p.y = 4 + 3 * d
      p.sy = 0.985 - 0.012 * d
      p.ey = 0.42 - 0.3 * d
      p.gy = 3
      p.fy = 2
      p.brow = 0.3
      p.sleep = 1
      p.mouthSleep = 1
    case .surprise:
      let v = mod(t, 4.8)
      let e = ease((v - 0.18) / 0.25) * (1 - ease((v - 2.05) / 0.85))
      p.r = -3 * e
      p.y = -3 * e
      p.sy = 1 + 0.035 * e
      p.ex = 1 + 0.3 * e
      p.ey = 1 + 0.5 * e
      p.fy = -2 * e
      p.brow = e
      p.o = e
    case .think:
      p.r = -8 + sin(a / 5) * 1.2
      p.fx = 3
      p.fy = -1
      p.gx = 6
      p.gy = -5
      p.ey = 0.92
      p.brow = 0.8
      p.asym = 1
      p.think = 1
      p.mouthSleep = 0.55
    case .shy:
      p.r = 7 + sin(a / 5.2) * 1.8
      p.y = 3
      p.sy = 0.985
      p.fx = -1
      p.fy = 2
      p.gx = -4.5 + sin(a / 5.2) * 1.5
      p.gy = 5
      p.ey = 0.82
      p.blush = 0.85 + sin(a / 3.5) * 0.1
      p.mouthShy = 1
    case .laugh:
      let v = mod(t, 4.8)
      let c = pulse(v, 0.55, 0.26) + 0.9 * pulse(v, 1.14, 0.28) + 0.72 * pulse(v, 1.75, 0.34)
      p.y = -2.3 - 2.6 * c + sin(a / 4.8) * 0.5
      p.r = -5 + sin(a / 4.8) * 1.2 + 0.7 * c
      p.sy = 0.986 + 0.008 * c
      p.sx = 1 + 0.008 * c
      p.fy = -1.6 - c
      p.gy = -0.6
      p.happy = 1
      p.joy = 1
      p.chuckle = c
      p.ex = 1.06 + 0.04 * c
      p.ey = 0.86 - 0.04 * c
      p.blush = 0.15 + 0.08 * c
    case .wink:
      let cycle = 2.83
      let v = mod(t, cycle)
      p.wink = ease((v - 0.2) / 0.23) * (1 - ease((v - 1.13) / 0.3))
      p.r = -6 + sin(a / cycle) * 1.5 - 1.2 * p.wink
      p.mouthHappy = 0.6
      p.blush = 0.25 + 0.15 * p.wink
      p.stars = 0.55 + 0.45 * p.wink
      p.gx = -2
    case .angry:
      p.x = sin(a * 5) * 0.9
      p.r = sin(a / 2) * 2
      p.ey = 0.8
      p.brow = 1
      p.anger = 1
      p.frown = 0.8
      p.blush = 0.5
      p.sy = 1 + sin(a) * 0.013
    case .cry:
      let v = mod(t, 4.6)
      let sob = pulse(v, 0.75, 0.28) + 0.85 * pulse(v, 1.45, 0.32)
      p.weeping = 1
      p.sob = sob
      p.tears = 1
      p.sad = 0.85
      p.gy = 0.6
      p.y = 2 + 2.8 * sob
      p.r = -1.5 + sin(a / 4.6) * 0.65
      p.sy = 1 - 0.014 * sob
      p.fy = 0.6 * sob
      p.blush = 0.12
    case .pout:
      p.r = 4 + sin(a / 4) * 1.4
      p.ey = 1.22
      p.ex = 1.08
      p.sad = 1
      p.brow = 0.8
      p.frown = 1
      p.blush = 0.35
      p.gy = 3
      p.y = 3
      p.fx = sin(a * 3) * 0.4
    case .confused:
      p.r = sin(a / 5) * 7 - 3
      p.brow = 0.9
      p.asym = 2
      p.gx = -4 + sin(a / 5) * 3
      p.mouthSleep = 0.8
      p.question = 1
      p.ey = 1.05
    case .sweat:
      p.r = -4
      p.ey = 0.43
      p.flat = 0.9
      p.sweat = 1
      p.brow = 0.45
      p.asym = 0.8
      p.x = sin(a / 3) * 1.5
    case .party:
      let v = mod(t, 4.8)
      let prep = pulse(v, 0.3, 0.24)
      let jump = pulse(v, 0.87, 0.52)
      p.celebrate = 1
      p.starEyes = 1
      p.confetti = 1
      p.blush = 0.26
      p.hop = 6.5 * jump - 0.8 * prep
      p.y = 0
      p.r = -1.3 + 1.1 * jump
      p.sy = 1 - 0.012 * prep
      p.fy = -0.6 * jump
    case .cool:
      p.r = -8 + sin(a / 5) * 2
      p.y = -3
      p.glasses = 1
      p.mouthShy = 0.7
      p.stars = 0.65
    case .please:
      p.r = sin(a / 3) * 2
      p.y = 3 + sin(a / 1.5) * 2
      p.ex = 1.35
      p.ey = 1.45
      p.brow = 0.6
      p.sad = 0.7
      p.blush = 0.5
      p.mouthShy = 1
      p.plead = 1
    case .kiss:
      p.r = -8 + sin(a / 3) * 2
      p.happy = 1
      p.kiss = 1
      p.blush = 0.7
      p.hearts = 1
      p.fx = 2 + sin(a / 3) * 2
    case .dizzy:
      p.r = sin(a / 3) * 8
      p.x = cos(a / 3) * 4
      p.y = sin(a / 1.5) * 3
      p.spiral = 1
      p.dizzy = 1
      p.o = 1
      p.sy = 0.99
    case .focus:
      p.r = -2
      p.ey = 0.72
      p.brow = 1
      p.anger = 0.5
      p.flat = 1
      p.focus = 1
      p.gx = sin(a / 4) * 3
      p.gy = 1
      p.y = -1 + sin(a / 6) * 0.5
    }
    return p
  }

  // MARK: - Shaping helpers (Web's `clamp`, `mod`, `ease`, `pulse`)

  static func clamp(_ value: Double, _ low: Double = 0, _ high: Double = 1) -> Double {
    max(low, min(high, value))
  }

  static func mod(_ value: Double, _ modulus: Double) -> Double {
    let remainder = value.truncatingRemainder(dividingBy: modulus)
    return remainder < 0 ? remainder + modulus : remainder
  }

  static func ease(_ input: Double) -> Double {
    let x = clamp(input)
    return x * x * (3 - 2 * x)
  }

  static func pulse(_ t: Double, _ center: Double, _ width: Double) -> Double {
    abs(t - center) > width ? 0 : pow(cos((t - center) / width * (.pi / 2)), 2)
  }

  /// Web's blink: three quick closes in every eight seconds, except where the eyes are shut.
  static func blink(_ mood: OkouAvatarMood, at time: Double) -> Double {
    if [.wink, .cry, .party].contains(mood) { return 1 }
    let t = mod(time, 8)
    return 1 - 0.94 * max(pulse(t, 1.98, 0.12), pulse(t, 5.43, 0.12), pulse(t, 6, 0.1))
  }

  // MARK: - Drawing (Web's `draw*` functions, writing node state instead of attributes)

  private static let originalMouth: [Double] = [
    112.337, 152.703, 118.827, 151.816, 124.63, 147.174, 126.795, 141.137,
  ]
  /// The mouth's other shapes, blended by the pose's `mouthHappy`, `mouthSleep`, `mouthShy`,
  /// `frown` and `flat`, in that order.
  private static let mouths: [[Double]] = [
    [105.5, 149.5, 114.2, 161, 128, 157, 131.5, 140.7],
    [115.8, 151.7, 119.1, 151.3, 123.2, 151.3, 125.6, 150.9],
    [114.2, 151, 118.3, 151.4, 122.4, 148.5, 124.9, 145.6],
    [111.7, 156.6, 116.2, 147.6, 123.6, 147.6, 128.1, 155],
    [113, 151.7, 117, 151.7, 123.2, 151.7, 127.7, 151.7],
  ]
  private static let sourceBrows: [OkouAvatarSide: [Double]] = [
    .left: [
      83.4219, 107.703, 84.5602, 107.248, 86.1572, 106.985, 87.7617, 106.987, 89.3662, 106.989,
      90.9608, 107.254, 92.0965, 107.71,
    ],
    .right: [
      132.578, 107.703, 131.44, 107.248, 129.843, 106.985, 128.238, 106.987, 126.634, 106.989,
      125.039, 107.254, 123.903, 107.71,
    ],
  ]

  private struct Writer {
    let mood: OkouAvatarMood
    let time: Double
    let p: Pose
    let before: Pose
    var frame = OkouAvatarFrame()

    init(mood: OkouAvatarMood, time: Double) {
      self.mood = mood
      self.time = time
      p = OkouAvatarRig.pose(mood, at: time)
      before = OkouAvatarRig.pose(mood, at: time - 0.11)
    }

    mutating func tf(_ id: String, _ transform: CGAffineTransform) {
      frame.transforms[id] = transform
    }

    mutating func opacity(_ id: String, _ value: Double) {
      frame.opacities[id] = clamp(value)
    }

    mutating func path(_ id: String, _ build: (inout Path) -> Void) {
      var path = Path()
      build(&path)
      frame.paths[id] = path
    }

    mutating func drawBody() {
      let unit = Double(Art.unit)
      tf("character-motion", Art.translate(0, -p.hop))
      frame.torsoClipped = p.celebrate <= 0
      tf(
        "head-motion",
        Art.svg(
          Art.translate(p.x * unit, p.y * unit),
          Art.about(Art.head.x, Art.head.y, Art.svg(Art.rotate(p.r), Art.scale(p.sx, p.sy)))))
      let neckBottom = 194.009
      let neckHeight = neckBottom - 178.707
      let overlap = abs(p.r) * 0.23
      let neckScale = clamp(1 + (overlap - p.y * unit) / neckHeight, 0.6, 1.8)
      let shear = -(p.x * unit) / neckHeight
      tf(
        "neck",
        CGAffineTransform(
          a: 1, b: 0, c: shear, d: neckScale, tx: -shear * neckBottom,
          ty: neckBottom * (1 - neckScale)))
      tf("face-track", Art.translate(p.fx * unit, p.fy * unit))
      tf("eyes-track", Art.translate(p.gx * unit, p.gy * unit))
    }

    mutating func drawEye(_ side: OkouAvatarSide) {
      let name = side.rawValue
      let wink = side == .right ? p.wink : 0
      let closedWink = ease((wink - 0.82) / 0.18)
      let smile = p.happy + (1 - p.happy) * closedWink
      let special = clamp(p.squeeze + p.spiral + p.starEyes + p.weeping)
      tf("eye-\(name)-motion", Art.scale(p.ex, p.ey * blink(mood, at: time)))
      let (starX, eyeX) = Art.eyeX(side)
      tf("eye-\(name)-dot", Art.about(eyeX, 121.373, Art.scale(1, 1 - 0.69 * wink)))
      opacity("eye-\(name)-dot", (1 - smile) * (1 - special))
      opacity("eye-\(name)-smile", smile * (1 - special))
      opacity("eye-\(name)-squeeze", p.squeeze)
      opacity("eye-\(name)-spiral", p.spiral)
      opacity("eye-\(name)-star", p.starEyes)
      opacity("eye-\(name)-cry", p.weeping)
      tf(
        "eye-\(name)-star",
        Art.svg(Art.translate(starX, 293), Art.scale(1.35 + 0.08 * clamp(p.hop / 6.5))))
      opacity("eye-\(name)-shine", p.plead)
      let span = 5.3 + 2.1 * p.joy + 0.6 * p.celebrate
      let outer = 122.6 - 0.4 * p.joy
      let inner = 122.6 - 1.1 * p.joy
      let start = side == .left ? outer : inner
      let end = side == .left ? inner : outer
      let peak = 115.2 + 3.4 * p.joy - 0.35 * p.chuckle - 0.4 * p.celebrate
      let x = Double(eyeX)
      path("eye-\(name)-smile") { path in
        path.move(to: pt(x - span, start))
        path.addQuadCurve(to: pt(x + span, end), control: pt(x, peak))
      }
    }

    private func browPoints(_ side: OkouAvatarSide) -> [Double] {
      let source = OkouAvatarRig.sourceBrows[side] ?? []
      let first = source[0]
      let last = source[12]
      return source.indices.map { index in
        let value = source[index]
        guard index % 2 == 1 else { return value }
        // Odd entries are y values; the x before each one places it along the brow.
        let ratio = (source[index - 1] - first) / (last - first)
        let asymmetry = side == .left ? -1.64 + 1.64 * ratio : 0.82 + 1.23 * ratio
        let joyLift = (side == .left ? 0.5 : 1) - 4.6 * ratio - 0.8 * sin(.pi * ratio)
        return value - 2.87 * p.o + (-3.28 + 5.33 * ratio) * p.anger
          + (2.87 - 6.15 * ratio) * p.sad + asymmetry * p.asym + p.joy * joyLift
          - 1.1 * p.celebrate
      }
    }

    mutating func drawFace() {
      opacity("cheeks", p.blush * 0.75)
      tf("cheeks", Art.translate(0, -0.7 * p.chuckle))
      tf(
        "nose",
        Art.about(
          108, 142.583, Art.svg(Art.translate(0, -0.6 * p.joy), Art.scale(1, 1 - 0.045 * p.joy))))
      for side in OkouAvatarSide.allCases {
        let b = browPoints(side)
        path("brow-\(side.rawValue)") { path in
          path.move(to: pt(b[0], b[1]))
          path.addCurve(to: pt(b[6], b[7]), control1: pt(b[2], b[3]), control2: pt(b[4], b[5]))
          path.addCurve(to: pt(b[12], b[13]), control1: pt(b[8], b[9]), control2: pt(b[10], b[11]))
        }
      }
    }

    mutating func drawMouth() {
      let weights = [p.mouthHappy, p.mouthSleep, p.mouthShy, p.frown, p.flat]
      let m = OkouAvatarRig.originalMouth.indices.map { index in
        let n = OkouAvatarRig.originalMouth[index]
        return n
          + zip(OkouAvatarRig.mouths, weights).reduce(0) { sum, mouth in
            sum + (mouth.0[index] - n) * mouth.1
          }
      }
      path("smile") { path in
        path.move(to: pt(m[0], m[1]))
        path.addCurve(to: pt(m[6], m[7]), control1: pt(m[2], m[3]), control2: pt(m[4], m[5]))
      }
      opacity("smile", 1 - clamp(p.o + p.laugh + p.joy + p.kiss + p.weeping + p.celebrate))
      opacity("mouth-o", p.o * (1 - p.laugh))
      opacity("mouth-laugh", p.laugh)
      opacity("mouth-kiss", p.kiss)
      opacity("mouth-cry", p.weeping)
      opacity("mouth-party", p.celebrate)
      let partyOpen = clamp(p.hop / 6.5)
      let partyBottom = 162 + 3.5 * partyOpen
      var party = Path()
      party.move(to: pt(104, 148.2))
      party.addQuadCurve(to: pt(131, 146.6), control: pt(117.5, 154))
      party.addCurve(
        to: pt(117.8, partyBottom), control1: pt(130.4, 158.2 + 1.9 * partyOpen),
        control2: pt(124.9, partyBottom))
      party.addCurve(to: pt(104, 148.2), control1: pt(110.6, partyBottom), control2: pt(106, 157.5))
      party.closeSubpath()
      for id in ["party-mouth-shape", "party-mouth-clip-shape", "party-mouth-outline"] {
        frame.paths[id] = party
      }
      frame.paths["party-mouth-tongue"] = Art.ellipse(118, partyBottom - 1.6, 5.8, 3)
      opacity("mouth-big-laugh", p.joy)
      let open = 0.35 + 0.65 * p.chuckle
      let bottom = 159 + 8 * open
      var laugh = Path()
      laugh.move(to: pt(92.5, 144))
      laugh.addQuadCurve(to: pt(137.5, 141.9), control: pt(112.5, 151.8))
      laugh.addCurve(
        to: pt(115.4, bottom), control1: pt(136.5, 155 + 2 * open), control2: pt(128, bottom))
      laugh.addCurve(
        to: pt(92.5, 144), control1: pt(102, bottom + 0.8), control2: pt(95, 156 + 2 * open))
      laugh.closeSubpath()
      for id in ["big-laugh-shape", "big-laugh-clip-shape", "big-laugh-outline"] {
        frame.paths[id] = laugh
      }
      path("big-laugh-teeth") { path in
        path.move(to: pt(89, 136))
        path.addLine(to: pt(142, 136))
        path.addLine(to: pt(142, 151.8 + 0.8 * open))
        path.addQuadCurve(to: pt(89, 153 + 0.8 * open), control: pt(115, 158 + open))
        path.closeSubpath()
      }
      opacity("big-laugh-tongue", 0)
      tf("mouth-o", Art.about(119.5, 153, Art.scale(0.8 + 0.2 * p.o, 0.75 + 0.25 * p.o)))
    }

    mutating func drawHair() {
      let unit = Double(Art.unit)
      let lag = (before.r - p.r) * 2.7
      tf("back-hair", Art.rotate(lag * 0.22 + sin(time * 1.4) * 0.65, around: 109.156, 83.1318))
      tf(
        "bun-bounce",
        Art.svg(
          Art.translate(0, clamp((p.y - before.y) * 0.22, -2, 2) * unit),
          Art.rotate(lag + sin(time * 1.6) * 1.3)))
      tf("bun-stretch", Art.scale(1 + sin(time * 1.6) * 0.008, 1 - sin(time * 1.6) * 0.012))
      tf(
        "fringe",
        Art.svg(
          Art.translate(0, clamp((p.y - before.y) * 0.1, -1.2, 1.2) * unit),
          Art.rotate(lag * 0.2, around: 108, 65.0596)))
      tf(
        "breathing",
        Art.scale(
          1 + sin(time * 1.6) * 0.003,
          1.015 + sin(time * 1.6) * 0.015 + 0.012 * p.chuckle + 0.008 * p.sob))
    }

    mutating func drawSleepAndThought() {
      opacity("sleep-marks", p.sleep)
      for index in 0..<3 {
        let z = mod(time / 3.6 + Double(index) / 3, 1)
        tf(
          "sleep-z-\(index)",
          Art.svg(Art.translate(384 + z * 42, 205 - z * 83), Art.scale(0.55 + z * 0.5)))
        opacity("sleep-z-\(index)", sin(.pi * z) * 0.8)
      }
      opacity("thinking-marks", p.think)
      for index in 0..<3 {
        let wave = sin(time * 3 - Double(index) * 1.4)
        opacity("think-dot-\(index)", 0.2 + 0.8 * (0.5 + 0.5 * wave))
        tf("think-dot-\(index)", Art.translate(0, -max(0, wave) * 4))
      }
      opacity("surprise-marks", p.o * (1 - p.tears) * (1 - p.dizzy) * 0.85)
      tf("surprise-marks", Art.translate(0, -p.o * 3))
      opacity("happy-marks", p.stars)
      for index in 0..<2 {
        let k = 0.7 + sin(time * 3 + Double(index) * 2) * 0.25
        let x: Double = index == 1 ? 425 : 92
        let y: Double = index == 1 ? 199 : 178
        tf(
          "sparkle-\(index)",
          Art.svg(Art.translate(x, y), Art.rotate(time * 14 * (index == 1 ? 1 : -1)), Art.scale(k)))
        opacity("sparkle-\(index)", 0.55 + sin(time * 3 + Double(index) * 2) * 0.3)
      }
    }

    mutating func drawTearsAndSweat() {
      opacity("tears", p.tears)
      for (index, side) in OkouAvatarSide.allCases.enumerated() {
        let i = Double(index)
        let f = mod(time / 1.45 + i * 0.47, 1)
        let tipY = 138.5 + sin(time * 2 + i) * 0.55
        let x = index == 1 ? 135.2 : 81.2
        path("tear-stream-\(side.rawValue)") { path in
          if index == 1 {
            path.move(to: pt(134, 124.1))
            path.addCurve(to: pt(x, tipY), control1: pt(135.9, 129), control2: pt(135.6, 133.4))
          } else {
            path.move(to: pt(82.2, 124.1))
            path.addCurve(to: pt(x, tipY), control1: pt(80.4, 129.1), control2: pt(80.5, 133.7))
          }
        }
        tf(
          "teardrop-\(side.rawValue)",
          Art.svg(
            Art.translate(x + sin(f * .pi) * 0.25 * (index == 1 ? 1 : -1), tipY + f * f * 16),
            Art.scale(0.72 + 0.28 * ease(f / 0.24))))
        opacity("teardrop-\(side.rawValue)", ease(f / 0.14) * (1 - ease((f - 0.72) / 0.28)))
        opacity("tear-stream-\(side.rawValue)", 0.86 + 0.1 * sin(time * 2 + i))
      }
      let sweatPhase = mod(time / 3, 1)
      opacity(
        "sweat-drop", p.sweat * ease(sweatPhase / 0.12) * (1 - ease((sweatPhase - 0.8) / 0.2)))
      tf("sweat-drop", Art.translate(0, sweatPhase * 50))
      opacity("glasses", p.glasses)
    }

    mutating func drawHeartsAndAnger() {
      opacity("kiss-hearts", p.hearts)
      for index in 0..<3 {
        let i = Double(index)
        let f = mod(time / 3 + i / 3, 1)
        let x = index == 1 ? 417 : 95 + i * 12
        tf(
          "kiss-heart-\(index)",
          Art.svg(
            Art.translate(x + sin(f * .pi * 2 + i) * 10, 278 - f * 130 - i * 12),
            Art.rotate(sin(f * 4) * 12), Art.scale(0.65 + 0.5 * f)))
        opacity("kiss-heart-\(index)", sin(.pi * f))
      }
      opacity("anger-marks", max(0, p.anger - 0.6) / 0.4)
      tf(
        "anger-vein",
        Art.svg(
          Art.translate(395, 183), Art.rotate(-16 + sin(time * 5) * 2),
          Art.scale(0.96 + sin(time * 5.8) * 0.055, 0.98 + sin(time * 5.8 + 0.9) * 0.045)))
      tf("anger-steam", Art.translate(0, -mod(time, 1.7) * 7))
      opacity("anger-steam", 0.25 + 0.55 * sin(.pi * mod(time / 1.7, 1)))
      opacity("question-mark", p.question)
      tf(
        "question-mark",
        Art.svg(Art.translate(415, 154 + sin(time * 2) * 5), Art.rotate(sin(time * 2) * 9)))
    }

    mutating func drawConfetti() {
      opacity("party-confetti", p.confetti)
      for index in 0..<16 {
        let j = Double(index % 8)
        let side: Double = index < 8 ? -1 : 1
        let age = mod(time, 4.8) - 0.58 - j * 0.045
        let f = clamp(age / 2.5)
        let speed = 240 + j * 32
        let y = 137 + Double(index % 8 % 3) * 5 - speed * f + speed * f * f
        let spread = 4 + Double(index % 8 % 4) * 3.5
        let inward = Double(index % 8 % 4) * 14 * ease((78 - y) / 28)
        let x =
          (side < 0 ? 24 : 193) + side * spread * sin(.pi * f) - side * inward + sin(f * 4 + j)
          * 1.5
        tf(
          "confetti-\(index)",
          Art.svg(
            Art.translate(x, y), Art.rotate(Double(index) * 39 + f * (index % 2 == 1 ? 180 : -160)),
            Art.scale(0.75 + Double(index % 8 % 3) * 0.12)))
        opacity("confetti-\(index)", ease(age / 0.12) * (1 - ease((f - 0.7) / 0.3)))
      }
    }

    mutating func drawDizzyAndFocus() {
      opacity("dizzy-stars", p.dizzy)
      for index in 0..<3 {
        let angle = time * 2 + Double(index) * .pi * 2 / 3
        tf(
          "dizzy-star-\(index)",
          Art.svg(
            Art.translate(259 + cos(angle) * 115, 128 + sin(angle) * 26), Art.rotate(time * 70),
            Art.scale(0.7)))
      }
      opacity("focus-marks", p.focus * (0.65 + 0.25 * sin(time * 2)))
      tf("focus-marks", Art.about(259, 295, Art.scale(1 + sin(time * 2) * 0.025)))
    }
  }
}

private func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }
