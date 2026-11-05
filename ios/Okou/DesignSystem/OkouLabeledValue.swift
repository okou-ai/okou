import SwiftUI

/// Keep both phrases intact when they fit; stack them before compressing text.
struct OkouLabeledValue: View {
  let label: Text
  let value: Text

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline, spacing: OkouSpace.md) {
        label.fixedSize()
        Spacer(minLength: 0)
        value.fixedSize()
      }
      VStack(alignment: .leading, spacing: OkouSpace.xs) {
        label
        value
      }
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
