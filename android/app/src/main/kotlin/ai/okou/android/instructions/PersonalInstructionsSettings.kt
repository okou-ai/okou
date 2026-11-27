package ai.okou.android.instructions

import ai.okou.android.OkouActionButton
import ai.okou.android.OkouActionTreatment
import ai.okou.android.OkouConfirmationDialog
import ai.okou.android.OkouFormActions
import ai.okou.android.OkouFormFieldSupport
import ai.okou.android.OkouFormLayout
import ai.okou.android.R
import ai.okou.android.SettingsSheet
import ai.okou.android.canAdoptConfirmedForm
import ai.okou.android.okouFormInputStyle
import ai.okou.android.okouFormSupportingLineHeight
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.replaceTextPreservingSelection
import ai.okou.android.state.rememberJournalTextField
import ai.okou.android.state.rememberSettingsFlag
import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
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
                    snapshotFlow { field.text.toString() to field.composition }.map { Unit },
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
        val current = model.uiState.value
        // The owner has accepted any native edit and already resolved its draft against the read.
        if (text != current.content && current.canEdit && !canAdoptConfirmedForm(false, field))
            return
        presented = current.content
        field.replaceTextPreservingSelection(presented)
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
        model.open(restoring)
        opened = true
        var firstResume = true
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                if (!firstResume) model.refreshFromForeground()
                firstResume = false
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            model.closePanel()
        }
    }
    var closeAfterSave by rememberSettingsFlag()
    var discardRevision by remember(model) { mutableStateOf<Long?>(null) }
    var editorFocused by rememberSettingsFlag()
    var editorKeyboardVisible by rememberSettingsFlag()
    LaunchedEffect(closeAfterSave, state.phase, state.saveConfirmed) {
        if (closeAfterSave && state.phase == InstructionsPhase.Ready && state.saveConfirmed) {
            closeAfterSave = false
            dismiss()
        }
    }
    val title = stringResource(R.string.instructions_title)
    val snackbar = remember { SnackbarHostState() }
    val refreshFailure =
        if (state.read == InstructionsRead.RefreshFailed)
            stringResource(R.string.instructions_refresh_failed)
        else null
    LaunchedEffect(refreshFailure) {
        if (refreshFailure != null)
            snackbar.showSnackbar(refreshFailure, duration = SnackbarDuration.Indefinite)
    }
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
    val saveFailed = state.localFailure || state.saveRejected
    val requestFeedback =
        when {
            state.localFailure -> R.string.instructions_local_failed
            state.saveRejected -> R.string.instructions_save_rejected
            state.read == InstructionsRead.Failed && editing != null ->
                R.string.instructions_load_failed
            else -> null
        }?.let { stringResource(it) }
    val supportLineHeight =
        okouFormSupportingLineHeight(stringResource(R.string.instructions_save_rejected))
    val supportHeight = supportLineHeight + OkouFormLayout.SupportingTextGap
    val inputStyle = okouFormInputStyle()
    val editorPadding = OutlinedTextFieldDefaults.contentPaddingWithoutLabel()
    val editorShape = OutlinedTextFieldDefaults.shape
    val editorMinHeight =
        with(LocalDensity.current) {
            maxOf(
                112.dp,
                inputStyle.lineHeight.toDp() * 2 +
                    editorPadding.calculateTopPadding() +
                    editorPadding.calculateBottomPadding() +
                    2.dp,
            )
        }
    fun acceptNativeInput() {
        editing?.synchronize(model) { closeAfterSave = false }
    }
    fun confirmDismiss(): Boolean {
        acceptNativeInput()
        val current = model.uiState.value
        if (current.saveInProgress) return false
        if (current.draft != null) {
            if (discardRevision == null) discardRevision = current.draftRevision
            return false
        }
        return true
    }
    fun requestDismiss() {
        if (confirmDismiss()) dismiss()
    }
    BackHandler {
        if (discardRevision != null) discardRevision = null else requestDismiss()
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
        snackbar = snackbar,
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
                val message = fieldError ?: requestFeedback
                val hasError = fieldError != null || saveFailed
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
                                if (hasError && message != null) error(message)
                            },
                    textStyle = inputStyle,
                    placeholder = {
                        Text(stringResource(R.string.instructions_placeholder), style = inputStyle)
                    },
                    supportingText = {
                        OkouFormFieldSupport(
                            message,
                            if (hasError) colors.error else colors.onSurfaceVariant,
                            Modifier.animateContentSize().heightIn(min = supportLineHeight),
                        )
                    },
                    isError = hasError,
                    lineLimits =
                        TextFieldLineLimits.MultiLine(minHeightInLines = 2, maxHeightInLines = 8),
                    keyboardOptions =
                        KeyboardOptions(showKeyboardOnFocus = !restoreFocus || restoreKeyboard),
                    shape = editorShape,
                    contentPadding = editorPadding,
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
                                        MaterialTheme.colorScheme.surfaceContainerHigh,
                                        editorShape,
                                    )
                                else Modifier,
                            )
                            .semantics { contentDescription = label },
                    )
                    Spacer(Modifier.height(supportHeight))
                }
            }
            if (editing == null && state.phase == InstructionsPhase.Failed) {
                InstructionsReadFailure(
                    Modifier.fillMaxWidth().height(editorMinHeight + supportHeight),
                )
            }
            if (state.phase == InstructionsPhase.Unavailable) {
                Text(
                    stringResource(R.string.instructions_unavailable),
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
    discardRevision?.let { revision ->
        OkouConfirmationDialog(
            onDismiss = { discardRevision = null },
            title = stringResource(R.string.instructions_discard),
            confirm = stringResource(R.string.instructions_discard),
            onConfirm = {
                discardRevision = null
                if (model.discardEdits(revision)) {
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
private fun InstructionsReadFailure(modifier: Modifier) {
    val colors = MaterialTheme.colorScheme
    Layout(
        modifier = modifier,
        content = {
            Box {
                if (colors.surface.luminance() < colors.onSurface.luminance()) {
                    Image(
                        painterResource(R.drawable.okou_load_failed_outline),
                        contentDescription = null,
                        modifier = Modifier.matchParentSize(),
                        colorFilter = ColorFilter.tint(colors.onSurface.copy(alpha = 0.38f)),
                    )
                }
                Image(painterResource(R.drawable.okou_load_failed), contentDescription = null)
            }
            Text(
                stringResource(R.string.instructions_load_failed),
                Modifier.testTag("instructions_read_failure").semantics {
                    liveRegion = LiveRegionMode.Polite
                },
                color = colors.onSurface,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )
        },
    ) { (illustration, label), constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val text = label.measure(Constraints(maxWidth = width, maxHeight = height))
        val available = height - text.height
        val gap = 12.dp.roundToPx().coerceAtMost(available)
        val image =
            illustration.measure(
                Constraints(
                    maxWidth = 112.dp.roundToPx().coerceAtMost(width),
                    maxHeight = available - gap,
                ),
            )
        val top = (available - gap - image.height) * 2 / 5
        layout(width, height) {
            image.placeRelative((width - image.width) / 2, top)
            text.placeRelative((width - text.width) / 2, top + image.height + gap)
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
    val saveLabel = stringResource(R.string.instructions_save)
    val savingLabel = stringResource(R.string.settings_saving)
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
