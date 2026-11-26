package ai.okou.android

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

internal enum class RenameFieldError {
    Required,
    TooLong,
}

internal data class RenameForm(val name: String, val error: RenameFieldError?, val canSave: Boolean)

internal class RenameDraft(
    initialName: String,
    val input: TextFieldState = TextFieldState(initialText = initialName),
) {
    private var confirmed by mutableStateOf(initialName)

    private val pristine: Boolean
        get() =
            input.composition == null &&
                normalizedRenameName(input.text) == normalizedRenameName(confirmed)

    fun receive(name: String, readOnly: Boolean = false): Boolean {
        if (name == confirmed) return false
        val replaceInput = !readOnly && pristine
        if (replaceInput) input.replaceTextPreservingSelection(name)
        confirmed = name
        return replaceInput
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
