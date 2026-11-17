package ai.okou.android.chat

import ai.okou.android.R
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun RunControlsPanel(model: RunControlsModel, history: ConversationHistoryModel, threadId: String) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val recovery by model.recovery.collectAsStateWithLifecycle()
    val confirmed by history.uiState.collectAsStateWithLifecycle()
    val output by history.output.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle, threadId) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) model.check(threadId)
        }
        lifecycle.addObserver(observer)
        model.check(threadId)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val runs = confirmed.takeIf { it.thread?.id == threadId }?.controlRunIds(output).orEmpty()
    val queued =
        confirmed.takeIf { it.thread?.id == threadId }?.transcript?.queuedEventIds.orEmpty()
    val messages =
        confirmed
            .takeIf { it.thread?.id == threadId }
            ?.transcript
            ?.messages
            .orEmpty()
            .associateBy { it.id }
    val pending = state.journal?.pending.orEmpty().filter { it.threadId == threadId }
    Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState())) {
        if (state.persistence == RunControlPersistence.Failed) {
            Text(stringResource(R.string.controls_storage_failed))
            TextButton(onClick = model::retryLocal) { Text(stringResource(R.string.retry)) }
        }
        if (runs.isNotEmpty())
            TextButton(
                onClick = { model.stop(threadId, runs) },
                enabled = state.journal != null && state.persistence != RunControlPersistence.Failed,
            ) {
                Text(stringResource(R.string.controls_stop))
            }
        for (event in queued) Column {
            FlowRow {
                Text(stringResource(R.string.controls_queued_automation))
                TextButton(
                    onClick = { model.skip(threadId, event) },
                    enabled =
                        state.journal != null && state.persistence != RunControlPersistence.Failed,
                ) {
                    Text(stringResource(R.string.controls_skip))
                }
            }
            messages[event]?.blocks?.forEach { Text(it.text) }
        }
        for (intent in pending) {
            val phase = state.phases.getValue(intent.id)
            Text(
                stringResource(
                    when (phase) {
                        RunControlPhase.Preparing -> R.string.controls_preparing
                        RunControlPhase.Sending -> R.string.controls_sending
                        RunControlPhase.Accepted -> R.string.controls_accepted
                        RunControlPhase.Checking -> R.string.controls_checking
                        RunControlPhase.Unknown -> R.string.controls_unknown
                        RunControlPhase.Retryable -> R.string.controls_retryable
                    }
                )
            )
            if (phase == RunControlPhase.Retryable)
                TextButton(onClick = { model.retry(intent.id) }) {
                    Text(stringResource(R.string.controls_retry_original))
                }
        }
        if (pending.isNotEmpty())
            TextButton(
                onClick = { model.check(threadId) },
                enabled =
                    pending.none {
                        state.phases[it.id] in
                            setOf(
                                RunControlPhase.Preparing,
                                RunControlPhase.Sending,
                                RunControlPhase.Checking,
                            )
                    },
            ) {
                Text(stringResource(R.string.controls_check))
            }
        state.notice
            ?.takeIf { it.threadId == threadId }
            ?.let {
                Text(
                    stringResource(
                        when (it.kind) {
                            RunControlNoticeKind.Recorded -> R.string.controls_recorded
                            RunControlNoticeKind.TargetSettled -> R.string.controls_target_settled
                            RunControlNoticeKind.ReadFailed -> R.string.controls_read_failed
                        }
                    )
                )
            }
        recovery
            .takeIf { it.threadId == threadId }
            ?.let {
                if (it.phase == CancellationReadPhase.Failed) {
                    Text(stringResource(R.string.controls_recovery_failed))
                    TextButton(onClick = { model.refreshRecovery(threadId) }) {
                        Text(stringResource(R.string.retry))
                    }
                } else if (it.phase == CancellationReadPhase.Ready && it.pending == true) {
                    Text(stringResource(R.string.controls_recovering))
                    TextButton(onClick = { model.refreshRecovery(threadId) }) {
                        Text(stringResource(R.string.controls_check))
                    }
                }
            }
    }
}
