package ai.okou.android

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange

internal enum class RenameFieldError {
    Required,
    TooLong,
}

internal data class RenameForm(val name: String, val error: RenameFieldError?, val canSave: Boolean)

internal class RenameDraft(initialName: String) {
    val input = TextFieldState(initialText = initialName)
    private var confirmed by mutableStateOf(initialName)

    private val pristine: Boolean
        get() = normalizedRenameName(input.text) == normalizedRenameName(confirmed)

    fun receive(name: String) {
        if (name == confirmed) return
        if (pristine) {
            input.edit {
                replace(0, length, name)
                selection = TextRange(name.length)
            }
        }
        confirmed = name
    }

    fun form(name: String, enabled: Boolean, maxLength: Int?): RenameForm =
        renameForm(if (pristine) name else input.text, name, enabled, maxLength)
}

internal fun renameForm(
    input: CharSequence,
    confirmedName: String,
    enabled: Boolean,
    maxLength: Int?,
): RenameForm {
    val name = normalizedRenameName(input)
    val changed = name != normalizedRenameName(confirmedName)
    val error =
        when {
            name.isEmpty() && changed -> RenameFieldError.Required
            maxLength != null && name.length > maxLength -> RenameFieldError.TooLong
            else -> null
        }
    return RenameForm(name, error, enabled && changed && error == null)
}

internal fun normalizedRenameName(input: CharSequence): String = input.toString().trim()
