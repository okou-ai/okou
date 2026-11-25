package ai.okou.android.chat

import ai.okou.android.OkouFormActions
import ai.okou.android.OkouFormLayout
import ai.okou.android.R
import ai.okou.android.RenameFieldError
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsSheetScroll
import ai.okou.android.isShortSettingsPanelWindow
import ai.okou.android.normalizedRenameName
import ai.okou.android.okouFormInputStyle
import androidx.annotation.StringRes
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
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
    projectName: Boolean = false,
) {
    val input = editor.field.input
    val submitted = editor.submitted
    val checking = status == RenameStatus.Checking
    val unconfirmed = checking || status == RenameStatus.Unconfirmed
    val readOnly = unconfirmed || status == RenameStatus.Saving
    LaunchedEffect(editor, confirmedName, readOnly) {
        if (!readOnly) editor.draft.receive(confirmedName)
    }
    val form = editor.draft.form(confirmedName, enabled && !readOnly, null)
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

    val hint = if (projectName) null else stringResource(R.string.chat_rename_trim_hint)
    val validation =
        if (form.error == RenameFieldError.Required) stringResource(R.string.chat_rename_required)
        else if (projectName) projectNameError(editor.field) else null
    val saveFailed = !readOnly && submitted == name && !confirmed
    val notice =
        when {
            status == RenameStatus.Saving && !projectName -> R.string.settings_saving
            checking && !projectName -> R.string.chat_rename_checking_result
            unconfirmed -> R.string.chat_rename_save_unconfirmed
            saveFailed || status == RenameStatus.Rejected && submitted == null ->
                R.string.chat_rename_save_failed
            else -> null
        }
    val label = stringResource(labelRes)
    val projectBusy = projectName && (status == RenameStatus.Saving || checking)
    SettingsSheet(
        title = stringResource(titleRes),
        onDismiss = dismiss,
        modifier = if (projectName) Modifier.projectNamePanelMotion() else Modifier,
        actionSpacing = OkouFormLayout.GroupGap,
        scroll = if (projectName) SettingsSheetScroll.Panel else SettingsSheetScroll.Body,
        fullScreenInShortWindow = projectName,
        dismissible = !projectBusy,
        actions = {
            OkouFormActions(
                cancelLabel = stringResource(R.string.chat_rename_cancel),
                confirmLabel =
                    stringResource(
                        when {
                            projectName && checking -> R.string.chat_project_checking
                            projectName && status == RenameStatus.Saving -> R.string.settings_saving
                            unconfirmed -> R.string.chat_rename_check_result
                            else -> R.string.chat_project_rename_save
                        },
                    ),
                cancel = dismiss,
                confirm = {
                    if (unconfirmed) check()
                    else {
                        val submittedName =
                            if (projectName) editor.field.submitProjectName() else name
                        if (submittedName != null && save(submittedName)) {
                            editor.submitted = submittedName
                        }
                    }
                },
                confirmEnabled = if (unconfirmed) !checking else form.canSave,
                cancelEnabled = !projectBusy,
                confirmLayoutLabels =
                    if (projectName)
                        projectNameActionLabels(
                            R.string.chat_project_rename_save,
                            R.string.settings_saving,
                        )
                    else emptyList(),
                confirmMinWidth = if (projectName) 89.dp else 0.dp,
                keepConfirmFocusWhilePending = projectBusy,
            )
        },
    ) {
        WorkspaceNameFormBody(
            editor.field,
            label,
            readOnly,
            validation,
            hint,
            notice,
            noticeIsError = notice == R.string.chat_rename_save_failed,
        )
    }
}

@Composable
internal fun CreateProjectSheet(
    editor: ProjectCreationEditor,
    phase: ProjectCreatePhase?,
    create: (String) -> Unit,
    check: () -> Unit,
    dismiss: () -> Unit,
) {
    val busy = phase?.inProgress == true || phase == ProjectCreatePhase.Confirmed
    val unconfirmed =
        phase == ProjectCreatePhase.Unconfirmed || phase == ProjectCreatePhase.Checking
    val field = editor.field
    val confirmEnabled = !busy && (unconfirmed || field.input.text.isNotBlank())
    val notice =
        when (phase) {
            ProjectCreatePhase.Unconfirmed,
            ProjectCreatePhase.Checking -> R.string.chat_project_create_unconfirmed
            ProjectCreatePhase.Rejected -> R.string.chat_project_create_failed
            ProjectCreatePhase.Creating,
            ProjectCreatePhase.Confirmed,
            null -> null
        }
    fun submit() {
        if (!confirmEnabled) return
        if (unconfirmed) check() else field.submitProjectName()?.let(create)
    }
    SettingsSheet(
        title = stringResource(R.string.chat_project_create),
        onDismiss = dismiss,
        modifier = Modifier.projectNamePanelMotion().testTag("create_project_sheet"),
        actionSpacing = OkouFormLayout.GroupGap,
        scroll = SettingsSheetScroll.Panel,
        dismissible = !busy,
        fullScreenInShortWindow = true,
        actions = {
            OkouFormActions(
                cancelLabel =
                    stringResource(
                        if (unconfirmed) R.string.chat_project_create_close
                        else R.string.chat_rename_cancel,
                    ),
                confirmLabel =
                    stringResource(
                        when (phase) {
                            ProjectCreatePhase.Creating,
                            ProjectCreatePhase.Confirmed -> R.string.chat_project_creating
                            ProjectCreatePhase.Checking -> R.string.chat_project_checking
                            ProjectCreatePhase.Unconfirmed -> R.string.chat_rename_check_result
                            ProjectCreatePhase.Rejected,
                            null -> R.string.chat_project_create_confirm
                        },
                    ),
                cancel = dismiss,
                confirm = ::submit,
                cancelEnabled = !busy,
                confirmEnabled = confirmEnabled,
                confirmLayoutLabels =
                    projectNameActionLabels(
                        R.string.chat_project_create_confirm,
                        R.string.chat_project_creating,
                    ),
                confirmMinWidth = 89.dp,
                keepConfirmFocusWhilePending = busy,
            )
        },
    ) {
        WorkspaceNameFormBody(
            field,
            stringResource(R.string.chat_project_name),
            readOnly = busy || unconfirmed,
            validation = projectNameError(field),
            hint = null,
            notice = notice,
            noticeIsError = phase == ProjectCreatePhase.Rejected,
            submit = ::submit,
        )
    }
}

@Composable
private fun projectNameActionLabels(@StringRes idle: Int, @StringRes pending: Int) =
    listOf(
        stringResource(idle),
        stringResource(pending),
        stringResource(R.string.chat_rename_check_result),
        stringResource(R.string.chat_project_checking),
    )

@Composable
private fun Modifier.projectNamePanelMotion(): Modifier =
    if (isShortSettingsPanelWindow()) this
    else animateContentSize(tween(250, easing = ChatListMotionEasing))

@Composable
private fun projectNameError(field: WorkspaceNameField): String? =
    if (
        field.overlongSubmission != null &&
            field.overlongSubmission == normalizedRenameName(field.input.text)
    )
        stringResource(R.string.chat_project_name_too_long, ProjectNameLimit)
    else null

@Composable
private fun WorkspaceNameFormBody(
    field: WorkspaceNameField,
    label: String,
    readOnly: Boolean,
    validation: String?,
    hint: String?,
    @StringRes notice: Int?,
    noticeIsError: Boolean,
    submit: (() -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    val focus = remember { FocusRequester() }
    val input = field.input
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
            onKeyboardAction = submit?.let { action -> { action() } },
            shape = MaterialTheme.shapes.medium,
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.onSurface),
            contentPadding = OkouFormLayout.FieldPadding,
        )
        LaunchedEffect(field) {
            focus.requestFocus()
            // The old field collapses its selection when losing focus during window teardown.
            val retainedSelection = field.focusedSelection
            if (input.selection != retainedSelection) input.edit { selection = retainedSelection }
            snapshotFlow { input.selection.takeIf { fieldFocused } }
                .filterNotNull()
                .collect {
                    field.focusedSelection = it
                }
        }
        if (field.overlongSubmission != null) {
            LaunchedEffect(field) {
                snapshotFlow { input.text }.collect { field.clearLengthErrorOnEdit() }
            }
        }
        val supportingText = validation ?: hint
        if (supportingText != null) {
            Spacer(Modifier.height(OkouFormLayout.SupportingTextGap))
            Text(
                supportingText,
                color = if (validation == null) colors.onSurfaceVariant else colors.error,
                style =
                    MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
            )
        }
        if (notice != null) {
            Spacer(Modifier.height(OkouFormLayout.GroupGap))
            Text(
                stringResource(notice),
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                color = if (noticeIsError) colors.error else colors.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
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
