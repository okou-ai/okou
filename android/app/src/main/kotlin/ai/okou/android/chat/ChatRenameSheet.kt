package ai.okou.android.chat

import ai.okou.android.OkouFormActions
import ai.okou.android.OkouFormLayout
import ai.okou.android.R
import ai.okou.android.SettingsSheet
import ai.okou.android.okouFormInputStyle
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.sp

internal enum class RenameStatus {
    Editing,
    Saving,
    Rejected,
    Unconfirmed,
    Checking,
}

@Composable
internal fun RenameListItemSheet(
    editor: ChatRenameEditor,
    confirmedName: String,
    @StringRes titleRes: Int,
    @StringRes labelRes: Int,
    enabled: Boolean,
    status: RenameStatus,
    checkEnabled: Boolean,
    check: () -> Unit,
    dismiss: () -> Unit,
    saved: () -> Unit,
    save: (String) -> Boolean,
    maxLength: Int? = null,
) {
    val baseline = editor.baseline
    val input = editor.input
    val submitted = editor.submitted
    val name = input.text.toString().trim()
    val checking = status == RenameStatus.Checking
    val unconfirmed = checking || status == RenameStatus.Unconfirmed
    val readOnly = unconfirmed || status == RenameStatus.Saving
    val confirmed = submitted != null && submitted == confirmedName && !readOnly
    LaunchedEffect(confirmed) { if (confirmed) saved() }

    val hint =
        if (maxLength == null) stringResource(R.string.chat_rename_trim_hint)
        else stringResource(R.string.connector_rename_hint, maxLength)
    val validation =
        when {
            name.isEmpty() && name != baseline -> stringResource(R.string.chat_rename_required)
            maxLength != null && name.length > maxLength -> hint
            else -> null
        }
    val canSave =
        enabled &&
            !readOnly &&
            name.isNotEmpty() &&
            validation == null &&
            name != baseline &&
            name != confirmedName.trim()
    val saveFailed = !readOnly && submitted == name && !confirmed
    val notice =
        when {
            status == RenameStatus.Saving -> R.string.settings_saving
            checking -> R.string.chat_rename_checking_result
            unconfirmed -> R.string.chat_rename_save_unconfirmed
            saveFailed || status == RenameStatus.Rejected && submitted == null ->
                R.string.chat_rename_save_failed
            else -> null
        }
    val colors = MaterialTheme.colorScheme
    val focus = remember { FocusRequester() }
    val label = stringResource(labelRes)
    SettingsSheet(
        title = stringResource(titleRes),
        onDismiss = dismiss,
        actionSpacing = OkouFormLayout.GroupGap,
        actions = {
            OkouFormActions(
                cancelLabel = stringResource(R.string.chat_rename_cancel),
                confirmLabel =
                    stringResource(
                        if (unconfirmed) R.string.chat_rename_check_result
                        else R.string.chat_project_rename_save,
                    ),
                cancel = dismiss,
                confirm = {
                    if (unconfirmed) check() else if (save(name)) editor.submitted = name
                },
                confirmEnabled = if (unconfirmed) checkEnabled && !checking else canSave,
            )
        },
    ) {
        Column {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(OkouFormLayout.LabelGap))
            OutlinedTextField(
                state = input,
                modifier =
                    Modifier.fillMaxWidth()
                        .heightIn(min = OutlinedTextFieldDefaults.MinHeight)
                        .focusRequester(focus)
                        .semantics {
                            contentDescription = label
                            if (validation != null) error(validation)
                        },
                textStyle = okouFormInputStyle(),
                readOnly = readOnly,
                isError = validation != null,
                lineLimits = TextFieldLineLimits.SingleLine,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                shape = MaterialTheme.shapes.medium,
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.onSurface),
                contentPadding = OkouFormLayout.FieldPadding,
            )
            LaunchedEffect(Unit) { focus.requestFocus() }
            Spacer(Modifier.height(OkouFormLayout.SupportingTextGap))
            Text(
                validation ?: hint,
                color = if (validation == null) colors.onSurfaceVariant else colors.error,
                style =
                    MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
            )
            if (notice != null) {
                Spacer(Modifier.height(OkouFormLayout.GroupGap))
                Text(
                    stringResource(notice),
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    color =
                        if (notice == R.string.chat_rename_save_failed) colors.error
                        else colors.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}
