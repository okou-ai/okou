package ai.okou.android.chat

import ai.okou.android.OkouFormActions
import ai.okou.android.OkouFormLayout
import ai.okou.android.R
import ai.okou.android.RenameFieldError
import ai.okou.android.SettingsSheet
import ai.okou.android.normalizedRenameName
import ai.okou.android.okouFormInputStyle
import ai.okou.android.renameForm
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.filterNotNull

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
    check: () -> Unit,
    dismiss: () -> Unit,
    saved: () -> Unit,
    save: (String) -> Boolean,
    maxLength: Int? = null,
) {
    val baseline = editor.baseline
    val input = editor.input
    val submitted = editor.submitted
    val checking = status == RenameStatus.Checking
    val unconfirmed = checking || status == RenameStatus.Unconfirmed
    val readOnly = unconfirmed || status == RenameStatus.Saving
    val form = renameForm(input.text, baseline, confirmedName, enabled && !readOnly, maxLength)
    val name = form.name
    val confirmed = submitted != null && submitted == confirmedName && !readOnly
    LaunchedEffect(confirmed, submitted) {
        if (
            confirmed &&
                editor.submitted == submitted &&
                normalizedRenameName(input.text) == submitted
        )
            saved()
    }

    val hint =
        if (maxLength == null) stringResource(R.string.chat_rename_trim_hint)
        else stringResource(R.string.connector_rename_hint, maxLength)
    val validation =
        when (form.error) {
            RenameFieldError.Required -> stringResource(R.string.chat_rename_required)
            RenameFieldError.TooLong -> hint
            null -> null
        }
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
                confirmEnabled = if (unconfirmed) !checking else form.canSave,
            )
        },
    ) {
        Column {
            var fieldFocused by remember { mutableStateOf(false) }
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(OkouFormLayout.LabelGap))
            OutlinedTextField(
                state = input,
                modifier =
                    Modifier.fillMaxWidth()
                        .heightIn(min = OutlinedTextFieldDefaults.MinHeight)
                        .focusRequester(focus)
                        .onFocusChanged { fieldFocused = it.isFocused }
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
            LaunchedEffect(editor) {
                focus.requestFocus()
                // The old field collapses its selection when losing focus during window teardown.
                val retainedSelection = editor.focusedSelection
                if (input.selection != retainedSelection)
                    input.edit { selection = retainedSelection }
                snapshotFlow { input.selection.takeIf { fieldFocused } }
                    .filterNotNull()
                    .collect { editor.focusedSelection = it }
            }
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

@Composable
internal fun RestoreRenameOriginFocus(
    request: WorkspaceRenameTarget,
    focus: FocusRequester,
    onFinished: (WorkspaceRenameTarget) -> Unit,
) {
    LaunchedEffect(request) {
        focus.requestFocus()
        onFinished(request)
    }
}
