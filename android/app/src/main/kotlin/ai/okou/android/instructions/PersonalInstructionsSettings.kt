package ai.okou.android.instructions

import ai.okou.android.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun PersonalInstructionsSettings(model: PersonalInstructionsModel) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        model.open()
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) model.refreshFromForeground()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    Column(
        Modifier.fillMaxWidth().imePadding().testTag("personal_instructions"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        HorizontalDivider()
        Text(
            stringResource(R.string.instructions_section),
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.semantics { heading() },
        )
        if (state.saved != null || state.draft != null) {
            var editing by
                rememberSaveable(
                    stateSaver =
                        listSaver<TextFieldValue, Int>(
                            // Text belongs to the draft owner, never the size-limited Activity
                            // bundle.
                            save = {
                                val selection =
                                    if (it.text == state.content) it.selection else TextRange.Zero
                                listOf(selection.start, selection.end)
                            },
                            restore = { TextFieldValue(state.content, TextRange(it[0], it[1])) },
                        )
                ) {
                    mutableStateOf(TextFieldValue(state.content))
                }
            // Only a deliberate authoritative replacement changes native editing text.
            val presented =
                if (editing.text == state.content) editing else TextFieldValue(state.content)
            if (state.phase != InstructionsPhase.Unavailable)
                OutlinedTextField(
                    value = presented,
                    onValueChange = { value ->
                        editing = value
                        model.edit(value.text)
                    },
                    label = { Text(stringResource(R.string.instructions_title)) },
                    modifier = Modifier.fillMaxWidth().testTag("instructions_editor"),
                    minLines = 5,
                    maxLines = 12,
                    readOnly = !state.canEdit,
                )
        }
        if (state.busy || state.persisting)
            LinearProgressIndicator(
                Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.onSurface,
            )
        val message =
            when (state.phase) {
                InstructionsPhase.Idle,
                InstructionsPhase.Loading -> R.string.instructions_loading
                InstructionsPhase.Saving -> R.string.instructions_saving
                InstructionsPhase.Conflict -> R.string.instructions_conflict
                InstructionsPhase.Uncertain -> R.string.instructions_uncertain
                InstructionsPhase.Failed -> R.string.instructions_load_failed
                InstructionsPhase.Unavailable -> R.string.instructions_unavailable
                InstructionsPhase.Ready ->
                    if (state.draft == null) R.string.instructions_current
                    else R.string.instructions_unsaved
            }
        Text(stringResource(message), Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        if (state.localFailure)
            Text(
                stringResource(R.string.instructions_local_failed),
                color = MaterialTheme.colorScheme.error,
            )
        if (state.saveRejected)
            Text(
                stringResource(R.string.instructions_save_rejected),
                color = MaterialTheme.colorScheme.error,
            )
        if (state.content.contains('\u0000'))
            Text(
                stringResource(R.string.instructions_invalid),
                color = MaterialTheme.colorScheme.error,
            )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            InstructionsAction(R.string.instructions_refresh, model::refresh, !state.busy)
            if (
                state.phase != InstructionsPhase.Unavailable &&
                    state.draft != null &&
                    state.draft?.attempted != true
            ) {
                InstructionsAction(R.string.instructions_save, model::save, state.canSave)
                InstructionsAction(
                    if (state.phase == InstructionsPhase.Conflict) R.string.instructions_reload
                    else R.string.instructions_discard,
                    model::discard,
                    !state.busy,
                )
            }
            if (state.canRetrySave)
                InstructionsAction(R.string.instructions_retry_save, model::save, true)
            if (state.localFailure)
                InstructionsAction(R.string.retry, model::retryLocalDraft, !state.busy)
        }
        Text(
            stringResource(R.string.instructions_timing),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun InstructionsAction(label: Int, action: () -> Unit, enabled: Boolean) {
    TextButton(
        onClick = action,
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(stringResource(label))
    }
}
