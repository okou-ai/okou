package ai.okou.android.instructions

import ai.okou.android.OkouActionButton
import ai.okou.android.OkouActionTreatment
import ai.okou.android.OkouConfirmationDialog
import ai.okou.android.OkouFormActions
import ai.okou.android.OkouFormFieldError
import ai.okou.android.OkouFormLayout
import ai.okou.android.R
import ai.okou.android.SettingsSheet
import ai.okou.android.okouFormSupportingTextHeight
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.state.rememberJournalTextField
import ai.okou.android.state.rememberSettingsFlag
import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.withContext

private val editorMinHeight = 112.dp

/** The native field owns input and selection. The shared owner receives immutable text edits. */
private class InstructionsInput(val field: TextFieldState) {
    private var presented = field.text.toString()
    private val inputChanges = Channel<Unit>(Channel.CONFLATED)
    private var changed = false

    val inputTransformation = InputTransformation {
        // Signal even if multiple user edits return to the same text within a frame.
        if (changes.changeCount != 0 && !originalText.contentEquals(asCharSequence())) {
            changed = true
            inputChanges.trySend(Unit)
        }
    }

    suspend fun observe(model: PersonalInstructionsModel, onEdit: () -> Unit) {
        // Process native change signals after the input transaction commits.
        withContext(Dispatchers.Main) {
            merge(
                    inputChanges.receiveAsFlow(),
                    snapshotFlow { field.text.toString() }.map { Unit },
                    model.uiState.map { it.content }.distinctUntilChanged().map { Unit },
                )
                .collect { synchronize(model, onEdit) }
        }
    }

    fun synchronize(model: PersonalInstructionsModel, onEdit: () -> Unit) {
        val text = field.text.toString()
        val edited = changed || text != presented
        changed = false
        if (edited && model.uiState.value.canEdit) {
            model.edit(text)
            onEdit()
        }
        presented = model.uiState.value.content
        if (text != presented) {
            field.edit {
                replace(0, length, presented)
                selection = TextRange.Zero
            }
        }
    }
}

@Composable
internal fun PersonalInstructionsSettings(
    model: PersonalInstructionsModel,
    dismiss: () -> Unit,
) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var opened by rememberSettingsFlag()
    DisposableEffect(model, lifecycle) {
        val read = model.uiState.value.read
        val restoring = opened && read == InstructionsRead.Ready
        if (!restoring) model.open()
        opened = true
        var firstResume = true
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                if (!firstResume) model.refreshFromForeground()
                firstResume = false
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    var closeAfterSave by rememberSettingsFlag()
    var discardDraft by remember(model) { mutableStateOf<InstructionsDraft?>(null) }
    var editorFocused by rememberSettingsFlag()
    var editorKeyboardVisible by rememberSettingsFlag()
    LaunchedEffect(closeAfterSave, state.phase, state.saveConfirmed) {
        if (closeAfterSave && state.phase == InstructionsPhase.Ready && state.saveConfirmed) {
            closeAfterSave = false
            dismiss()
        }
    }
    val title = stringResource(R.string.instructions_title)
    val editing =
        if (
            state.read != InstructionsRead.Unavailable &&
                (state.saved != null || state.draft != null)
        ) {
            val field = rememberJournalTextField(state.content)
            val input = remember(field, model) { InstructionsInput(field) }
            LaunchedEffect(input) { input.observe(model) { closeAfterSave = false } }
            input
        } else null
    val fieldError =
        if (state.content.contains('\u0000')) stringResource(R.string.instructions_invalid)
        else null
    val supportHeight = okouFormSupportingTextHeight() + OkouFormLayout.SupportingTextGap
    fun acceptNativeInput() {
        editing?.synchronize(model) { closeAfterSave = false }
    }
    fun confirmDismiss(): Boolean {
        acceptNativeInput()
        val current = model.uiState.value
        if (current.saveInProgress) return false
        val draft = current.draft
        if (draft != null) {
            if (discardDraft == null) discardDraft = draft
            return false
        }
        return true
    }
    fun requestDismiss() {
        if (confirmDismiss()) dismiss()
    }
    BackHandler {
        if (discardDraft != null) discardDraft = null else requestDismiss()
    }
    fun save() {
        acceptNativeInput()
        val current = model.uiState.value
        if (!current.canSave) return
        closeAfterSave = true
        model.save()
    }
    SettingsSheet(
        title,
        ::requestDismiss,
        dismissible = !state.saveInProgress,
        confirmDismiss =
            if (state.saveInProgress || state.draft != null) ::confirmDismiss else null,
        fullScreenInShortWindow = true,
        actionSpacing = OkouFormLayout.GroupGap,
        actions = { InstructionsActions(state, model, ::requestDismiss, ::save) },
    ) {
        Column(
            Modifier.fillMaxWidth().testTag("personal_instructions"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (editing != null) {
                val focus = remember { FocusRequester() }
                val restoreFocus = remember { editorFocused }
                val restoreKeyboard = remember { editorKeyboardVisible }
                val keyboardVisible = WindowInsets.isImeVisible
                SideEffect {
                    if (editorFocused && lifecycle.currentState == Lifecycle.State.RESUMED) {
                        editorKeyboardVisible = keyboardVisible
                    }
                }
                LaunchedEffect(focus) {
                    if (restoreFocus) focus.requestFocus()
                }
                val colors = MaterialTheme.colorScheme
                val textStyle = MaterialTheme.typography.bodyLarge
                OutlinedTextField(
                    state = editing.field,
                    inputTransformation = editing.inputTransformation,
                    outputTransformation =
                        rememberInstructionsMarkdown(editing.field.text.toString()),
                    modifier =
                        Modifier.fillMaxWidth()
                            .heightIn(min = editorMinHeight + supportHeight)
                            .focusRequester(focus)
                            .onFocusChanged {
                                // Window teardown should not clear the saved focus intent.
                                if (
                                    it.isFocused ||
                                        lifecycle.currentState == Lifecycle.State.RESUMED
                                ) {
                                    editorFocused = it.isFocused
                                }
                            }
                            .testTag("instructions_editor")
                            .semantics {
                                contentDescription = title
                                if (fieldError != null) error(fieldError)
                            },
                    textStyle = textStyle.copy(color = colors.onSurface),
                    placeholder = {
                        Text(stringResource(R.string.instructions_placeholder), style = textStyle)
                    },
                    supportingText = { OkouFormFieldError(fieldError) },
                    isError = fieldError != null,
                    lineLimits =
                        TextFieldLineLimits.MultiLine(minHeightInLines = 3, maxHeightInLines = 8),
                    keyboardOptions =
                        KeyboardOptions(showKeyboardOnFocus = !restoreFocus || restoreKeyboard),
                    shape = RoundedCornerShape(12.dp),
                    colors =
                        OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.onSurface),
                    contentPadding = OkouFormLayout.FieldPadding,
                    readOnly = !state.canEdit,
                )
            }
            val loading =
                editing == null &&
                    state.phase in setOf(InstructionsPhase.Idle, InstructionsPhase.Loading)
            if (loading) {
                val showSkeleton = rememberContentReadSkeleton()
                val label = stringResource(R.string.instructions_loading)
                Column {
                    Box(
                        Modifier.fillMaxWidth()
                            .height(editorMinHeight)
                            .then(
                                if (showSkeleton)
                                    Modifier.background(
                                        MaterialTheme.colorScheme.surfaceVariant,
                                        RoundedCornerShape(12.dp),
                                    )
                                else Modifier,
                            )
                            .semantics { contentDescription = label },
                    )
                    Spacer(Modifier.height(supportHeight))
                }
            }
            val message =
                when {
                    state.phase == InstructionsPhase.Unavailable ->
                        R.string.instructions_unavailable
                    state.phase == InstructionsPhase.Failed -> R.string.instructions_load_failed
                    else -> null
                }
            if (message != null) {
                Text(
                    stringResource(message),
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
    discardDraft?.let { draft ->
        OkouConfirmationDialog(
            onDismiss = { discardDraft = null },
            title = stringResource(R.string.instructions_discard),
            confirm = stringResource(R.string.instructions_discard),
            onConfirm = {
                discardDraft = null
                if (model.discardEdits(draft)) {
                    closeAfterSave = false
                    dismiss()
                }
            },
        ) {
            Text(stringResource(R.string.instructions_unsaved))
        }
    }
}

@Composable
private fun InstructionsActions(
    state: PersonalInstructionsState,
    model: PersonalInstructionsModel,
    cancel: () -> Unit,
    save: () -> Unit,
) {
    val saving = state.phase == InstructionsPhase.Saving
    val operationMessage =
        when {
            state.localFailure -> R.string.instructions_local_failed
            state.saveRejected -> R.string.instructions_save_rejected
            state.phase == InstructionsPhase.Checking -> R.string.instructions_checking
            state.phase == InstructionsPhase.Uncertain -> R.string.instructions_uncertain
            state.read == InstructionsRead.RefreshFailed -> R.string.instructions_refresh_failed
            else -> null
        }
    val saveLabel = stringResource(R.string.instructions_save)
    val savingLabel = stringResource(R.string.settings_saving)
    val statusStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp)
    Column(Modifier.fillMaxWidth()) {
        OkouFormActions(
            cancelLabel = stringResource(R.string.settings_cancel),
            confirmLabel = if (saving) savingLabel else saveLabel,
            cancel = cancel,
            confirm = save,
            cancelEnabled = !state.saveInProgress,
            confirmEnabled = state.canSave,
            confirmLayoutLabels = listOf(saveLabel, savingLabel),
        )
        Column(Modifier.fillMaxWidth().animateContentSize()) {
            Box(Modifier.fillMaxWidth()) {
                for (message in
                    listOf(
                        R.string.instructions_checking,
                        R.string.instructions_uncertain,
                        R.string.instructions_save_rejected,
                        R.string.instructions_local_failed,
                        R.string.instructions_refresh_failed,
                    )) {
                    Text(
                        stringResource(message),
                        Modifier.clearAndSetSemantics {}.alpha(0f),
                        style = statusStyle,
                    )
                }
                if (operationMessage != null) {
                    Text(
                        stringResource(operationMessage),
                        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = statusStyle,
                    )
                }
            }
            if (state.localFailure) {
                OkouActionButton(
                    label = stringResource(R.string.retry),
                    onClick = model::retryLocalDraft,
                    enabled = !state.busy,
                    treatment = OkouActionTreatment.Text,
                )
            }
        }
    }
}
