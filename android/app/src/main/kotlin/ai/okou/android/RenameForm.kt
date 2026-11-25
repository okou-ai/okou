package ai.okou.android

internal enum class RenameFieldError {
    Required,
    TooLong,
}

internal data class RenameForm(val name: String, val error: RenameFieldError?, val canSave: Boolean)

internal fun renameForm(
    input: CharSequence,
    openingName: String,
    confirmedName: String,
    enabled: Boolean,
    maxLength: Int?,
): RenameForm {
    val name = normalizedRenameName(input)
    val changed = name != normalizedRenameName(openingName)
    val error =
        when {
            name.isEmpty() && changed -> RenameFieldError.Required
            maxLength != null && name.length > maxLength -> RenameFieldError.TooLong
            else -> null
        }
    return RenameForm(
        name,
        error,
        enabled &&
            changed &&
            name.isNotEmpty() &&
            error == null &&
            name != normalizedRenameName(confirmedName),
    )
}

internal fun normalizedRenameName(input: CharSequence): String = input.toString().trim()
