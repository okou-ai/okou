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
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.LineHeightStyle
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
    confirmedEventId: String?,
    @StringRes titleRes: Int,
    @StringRes labelRes: Int,
    enabled: Boolean,
    status: RenameStatus,
    check: () -> Unit,
    dismiss: () -> Unit,
    saved: () -> Unit,
    save: (String) -> RenameSubmission?,
    projectName: Boolean = false,
) {
    val input = editor.field.input
    val submitted = editor.submitted
    val checking = status == RenameStatus.Checking
    val unconfirmed = checking || status == RenameStatus.Unconfirmed
    val readOnly = unconfirmed || status == RenameStatus.Saving
    val form = editor.form(confirmedName, enabled && !readOnly)
    val name = form.name
    if (
        submitted != null &&
            submitted.eventId == confirmedEventId &&
            normalizedRenameName(input.text) == submitted.name
    ) {
        LaunchedEffect(submitted) {
            if (editor.submitted == submitted && normalizedRenameName(input.text) == submitted.name)
                saved()
        }
        return
    }

    LaunchedEffect(editor, confirmedName, readOnly) {
        editor.updateConfirmedName(confirmedName, readOnly)
    }

    val validation = form.error ?: if (projectName) projectNameError(editor.field) else null
    val notice =
        when {
            status == RenameStatus.Saving && !projectName -> R.string.settings_saving
            checking && !projectName -> R.string.chat_rename_checking_result
            unconfirmed -> R.string.chat_rename_save_unconfirmed
            status == RenameStatus.Rejected && (submitted == null || submitted.name == name) ->
                R.string.chat_rename_save_failed
            else -> null
        }
    val label = stringResource(labelRes)
    val projectBusy = projectName && (status == RenameStatus.Saving || checking)
    SettingsSheet(
        title = stringResource(titleRes),
        onDismiss = dismiss,
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
                        submittedName?.let(save)?.let { editor.submitted = it }
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
            projectName,
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
        modifier = Modifier.testTag("create_project_sheet"),
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
            projectName = true,
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

private fun projectNameError(field: WorkspaceNameField): RenameFieldError? =
    if (
        field.overlongSubmission != null &&
            field.overlongSubmission == normalizedRenameName(field.input.text)
    )
        RenameFieldError.TooLong
    else null

@Composable
private fun WorkspaceNameFormBody(
    field: WorkspaceNameField,
    label: String,
    readOnly: Boolean,
    validation: RenameFieldError?,
    projectName: Boolean,
    @StringRes notice: Int?,
    noticeIsError: Boolean,
    submit: (() -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    val focus = remember { FocusRequester() }
    val input = field.input
    val requiredMessage = stringResource(R.string.chat_rename_required)
    val lengthMessage =
        if (projectName) stringResource(R.string.chat_project_name_too_long, ProjectNameLimit)
        else null
    val validationMessage =
        when (validation) {
            RenameFieldError.Required -> requiredMessage
            RenameFieldError.TooLong -> lengthMessage
            null -> null
        }
    val lineHeightStyle =
        LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)
    val supportingStyle =
        MaterialTheme.typography.bodySmall.copy(
            fontSize = 12.sp,
            lineHeight = 16.sp,
            lineHeightStyle = lineHeightStyle,
        )
    val inputStyle = okouFormInputStyle().copy(lineHeightStyle = lineHeightStyle)
    val density = LocalDensity.current
    val textMeasurer = rememberTextMeasurer()
    // A fallback font can need more vertical space than the configured line height.
    val supportingLineHeight =
        remember(textMeasurer, density, supportingStyle, requiredMessage, lengthMessage) {
            with(density) {
                listOfNotNull(requiredMessage, lengthMessage)
                    .maxOf {
                        textMeasurer
                            .measure(
                                AnnotatedString(it),
                                supportingStyle,
                                softWrap = false,
                                maxLines = 1,
                            )
                            .size
                            .height
                            .toDp()
                    }
                    .coerceAtLeast(supportingStyle.lineHeight.toDp())
            }
        }
    val inputLineHeight = with(density) { inputStyle.lineHeight.toDp() }
    val outlineMinHeight = OutlinedTextFieldDefaults.MinHeight
    val fieldPadding = OkouFormLayout.FieldPadding.calculateTopPadding()
    // Material's minimum includes the supporting slot. Center the short input in its own outline.
    val inputVerticalPadding = maxOf(fieldPadding, (outlineMinHeight - inputLineHeight) / 2)
    Column {
        var fieldFocused by remember { mutableStateOf(false) }
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(OkouFormLayout.LabelGap))
        OutlinedTextField(
            state = input,
            modifier =
                Modifier.fillMaxWidth()
                    .heightIn(
                        min =
                            outlineMinHeight +
                                OkouFormLayout.SupportingTextGap +
                                supportingLineHeight,
                    )
                    .focusRequester(focus)
                    .onFocusChanged { fieldFocused = it.isFocused }
                    .semantics {
                        contentDescription = label
                        if (validationMessage != null) error(validationMessage)
                    },
            textStyle = inputStyle,
            readOnly = readOnly,
            supportingText = {
                Box(
                    Modifier.fillMaxWidth()
                        .animateContentSize(tween(250, easing = ChatListMotionEasing))
                        .heightIn(min = supportingLineHeight),
                ) {
                    if (validationMessage != null)
                        Text(validationMessage, color = colors.error, style = supportingStyle)
                }
            },
            isError = validationMessage != null,
            lineLimits = TextFieldLineLimits.SingleLine,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            onKeyboardAction = submit?.let { action -> { action() } },
            shape = MaterialTheme.shapes.medium,
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.onSurface),
            contentPadding =
                PaddingValues(horizontal = fieldPadding, vertical = inputVerticalPadding),
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
        val noticeMotion =
            if (projectName && !isShortSettingsPanelWindow())
                Modifier.animateContentSize(tween(250, easing = ChatListMotionEasing))
            else Modifier
        Column(Modifier.fillMaxWidth().then(noticeMotion)) {
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
