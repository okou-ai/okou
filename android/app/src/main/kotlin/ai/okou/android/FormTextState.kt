package ai.okou.android

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.ui.text.TextRange

internal fun TextFieldState.replaceTextPreservingSelection(value: String) {
    if (text.contentEquals(value)) return
    val previousSelection = selection
    edit {
        replace(0, length, value)
        selection =
            TextRange(
                previousSelection.start.coerceAtMost(length),
                previousSelection.end.coerceAtMost(length),
            )
    }
}
