package ai.okou.android.instructions

import ai.okou.android.R
import ai.okou.android.SettingsConfirmation
import ai.okou.android.SettingsSheet
import ai.okou.android.state.rememberJournalEditor
import ai.okou.android.state.rememberSettingsFlag
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay

@Composable
internal fun PersonalInstructionsSettings(
    model: PersonalInstructionsModel,
    dismiss: () -> Unit,
    offline: Boolean,
) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle, offline) {
        model.open()
        val observer = LifecycleEventObserver { _, event ->
            if (!offline && event == Lifecycle.Event.ON_RESUME) model.refreshFromForeground()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    var closeAfterSave by rememberSettingsFlag()
    var confirmDiscard by rememberSettingsFlag()
    LaunchedEffect(closeAfterSave, state.phase, state.draft) {
        if (closeAfterSave && state.phase == InstructionsPhase.Ready && state.draft == null) {
            closeAfterSave = false
            dismiss()
        }
    }
    val title = stringResource(R.string.instructions_title)
    fun save() {
        closeAfterSave = true
        model.save()
    }
    SettingsSheet(
        title,
        dismiss,
        actions = {
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement =
                    Arrangement.spacedBy(8.dp, androidx.compose.ui.Alignment.End),
            ) {
                InstructionsAction(
                    R.string.settings_cancel,
                    {
                        if (state.canEdit && state.draft != null) confirmDiscard = true
                        else dismiss()
                    },
                    true,
                )
                Button(
                    onClick = ::save,
                    enabled = !offline && (state.canSave || state.canRetrySave),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(
                        stringResource(
                            if (state.phase == InstructionsPhase.Saving) R.string.settings_saving
                            else if (state.canRetrySave) R.string.instructions_retry_save
                            else R.string.instructions_save
                        )
                    )
                }
            }
        },
    ) {
        Column(
            Modifier.fillMaxWidth().testTag("personal_instructions"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val haveEditor =
                state.phase != InstructionsPhase.Unavailable &&
                    (state.saved != null || state.draft != null)
            if (haveEditor) {
                val editing =
                    rememberJournalEditor(state.content, replacementSelection = TextRange.Zero)
                OutlinedTextField(
                    value = editing.value,
                    onValueChange = { value ->
                        editing.edit(value)
                        model.edit(value.text)
                    },
                    modifier =
                        Modifier.fillMaxWidth()
                            .heightIn(min = 112.dp)
                            .testTag("instructions_editor")
                            .semantics { contentDescription = title },
                    textStyle = MaterialTheme.typography.bodyLarge,
                    shape = RoundedCornerShape(12.dp),
                    placeholder = { Text(stringResource(R.string.instructions_placeholder)) },
                    minLines = 3,
                    maxLines = 8,
                    readOnly = !state.canEdit,
                )
            }
            val loading =
                !haveEditor &&
                    state.phase in setOf(InstructionsPhase.Idle, InstructionsPhase.Loading)
            if (loading && !offline) {
                var showSkeleton by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    delay(100)
                    showSkeleton = true
                }
                val label = stringResource(R.string.instructions_loading)
                Box(
                    Modifier.fillMaxWidth()
                        .height(112.dp)
                        .then(
                            if (showSkeleton)
                                Modifier.background(
                                    MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(12.dp),
                                )
                            else Modifier
                        )
                        .semantics { contentDescription = label }
                )
            }
            val message =
                when {
                    state.localFailure -> R.string.instructions_local_failed
                    state.saveRejected -> R.string.instructions_save_rejected
                    state.content.contains('\u0000') -> R.string.instructions_invalid
                    state.phase == InstructionsPhase.Conflict -> R.string.instructions_conflict
                    state.phase == InstructionsPhase.Uncertain -> R.string.instructions_uncertain
                    state.phase == InstructionsPhase.Unavailable ->
                        R.string.instructions_unavailable
                    offline -> R.string.chat_list_load_when_online
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
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.phase == InstructionsPhase.Conflict)
                    InstructionsAction(
                        R.string.instructions_reload,
                        {
                            closeAfterSave = false
                            model.discard()
                        },
                        !offline,
                    )
                if (
                    state.phase == InstructionsPhase.Failed ||
                        state.phase == InstructionsPhase.Uncertain
                )
                    InstructionsAction(R.string.instructions_refresh, model::refresh, !offline)
                if (state.localFailure)
                    InstructionsAction(R.string.retry, model::retryLocalDraft, !state.busy)
            }
        }
    }
    if (confirmDiscard) {
        SettingsConfirmation(
            onDismiss = { confirmDiscard = false },
            title = stringResource(R.string.instructions_discard),
            message = stringResource(R.string.instructions_unsaved),
            confirm = stringResource(R.string.instructions_discard),
            onConfirm = {
                closeAfterSave = false
                confirmDiscard = false
                model.discard()
                dismiss()
            },
        )
    }
}

@Composable
private fun InstructionsAction(label: Int, action: () -> Unit, enabled: Boolean) {
    TextButton(
        onClick = action,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(stringResource(label))
    }
}
