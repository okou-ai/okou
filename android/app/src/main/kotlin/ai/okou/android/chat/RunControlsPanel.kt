package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.currentWindowSizeDp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

internal class ConversationRunControls(
    val model: RunControlsModel,
    val threadId: String,
    val state: RunControlsState,
    val confirmed: ConversationUiState?,
    val currentRunId: String?,
    val pending: List<RunControlIntent>,
    val offline: Boolean,
) {
    val hasFeedback =
        state.persistence == RunControlPersistence.Failed ||
            pending.isNotEmpty() ||
            state.notice?.threadId == threadId ||
            confirmed?.detailPhase == ChatReadPhase.Failed ||
            confirmed?.detail?.cancellationRecoveryPending == true

    private val available =
        !offline && state.journal != null && state.persistence != RunControlPersistence.Failed

    val canStop =
        currentRunId != null &&
            available &&
            pending.none { it.kind == RunControlKind.Interrupt && it.targetId == currentRunId }

    fun stop() {
        if (canStop) model.stop(threadId, listOf(checkNotNull(currentRunId)))
    }

    fun revoke(eventId: String): (() -> Unit)? {
        if (
            !available ||
                eventId !in confirmed?.transcript?.pendingInputIds.orEmpty() ||
                pending.any { it.kind == RunControlKind.Revoke && it.targetId == eventId }
        )
            return null
        return { model.skip(threadId, eventId) }
    }
}

@Composable
internal fun conversationRunControls(
    model: RunControlsModel,
    history: ConversationHistoryModel,
    threadId: String,
    offline: Boolean,
): ConversationRunControls {
    val state by model.uiState.collectAsStateWithLifecycle()
    val historyState by history.uiState.collectAsStateWithLifecycle()
    val output by history.output.state.collectAsStateWithLifecycle()
    val confirmed = historyState.takeIf { it.thread?.id == threadId }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle, threadId) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) model.check(threadId)
        }
        lifecycle.addObserver(observer)
        model.check(threadId)
        onDispose { lifecycle.removeObserver(observer) }
    }
    return ConversationRunControls(
        model,
        threadId,
        state,
        confirmed,
        confirmed?.controlRunIds(output)?.lastOrNull(),
        state.journal?.pending.orEmpty().filter { it.threadId == threadId },
        offline,
    )
}

@Composable
internal fun ConversationStatus(
    offline: Boolean,
    controls: ConversationRunControls?,
    short: Boolean,
) {
    val stop = controls?.takeIf { it.currentRunId != null }
    if (!offline && stop == null) return
    if (short) {
        if (offline) ConversationOffline(short = true)
        if (stop != null) {
            val stopLabel = stringResource(R.string.controls_stop)
            IconButton(
                onClick = stop::stop,
                enabled = stop.canStop,
                modifier = Modifier.size(48.dp).semantics { contentDescription = stopLabel },
            ) {
                Icon(
                    painterResource(R.drawable.ic_stop),
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    } else {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 48.dp)
                .padding(horizontal = composerHorizontalInset(currentWindowSizeDp())),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (offline) ConversationOffline(short = false)
            Spacer(Modifier.weight(1f))
            if (stop != null)
                TextButton(
                    onClick = stop::stop,
                    enabled = stop.canStop,
                    colors =
                        ButtonDefaults.textButtonColors(
                            contentColor = MaterialTheme.colorScheme.onSurface
                        ),
                ) {
                    Icon(painterResource(R.drawable.ic_stop), null, Modifier.size(16.dp))
                    Text(
                        stringResource(R.string.conversation_stop),
                        Modifier.padding(start = 4.dp),
                        style =
                            MaterialTheme.typography.bodySmall.copy(
                                fontSize = 13.sp,
                                lineHeight = 20.sp,
                            ),
                    )
                }
        }
    }
}

@Composable
private fun ConversationOffline(short: Boolean) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(horizontal = if (short) 4.dp else 0.dp),
    ) {
        Icon(painterResource(R.drawable.ic_wifi_off), null, Modifier.size(16.dp), tint = color)
        Text(
            stringResource(R.string.chat_list_offline),
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style =
                MaterialTheme.typography.bodySmall.copy(
                    fontSize = if (short) 12.sp else 13.sp,
                    lineHeight = if (short) 16.sp else 20.sp,
                ),
        )
    }
}

@Composable
internal fun RunControlsFeedback(controls: ConversationRunControls) {
    val model = controls.model
    val threadId = controls.threadId
    val state = controls.state
    val pending = controls.pending
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (state.persistence == RunControlPersistence.Failed) {
            Text(stringResource(R.string.controls_storage_failed))
            TextButton(onClick = model::retryLocal) { Text(stringResource(R.string.retry)) }
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
                TextButton(onClick = { model.retry(intent.id) }, enabled = !controls.offline) {
                    Text(stringResource(R.string.controls_retry_original))
                }
        }
        if (pending.isNotEmpty())
            TextButton(
                onClick = { model.check(threadId) },
                enabled =
                    !controls.offline &&
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
        controls.confirmed?.let {
            if (it.detailPhase == ChatReadPhase.Failed) {
                Text(stringResource(R.string.controls_recovery_failed))
                TextButton(
                    onClick = { model.refreshRecovery(threadId) },
                    enabled = !controls.offline,
                ) {
                    Text(stringResource(R.string.retry))
                }
            } else if (
                it.detailPhase == ChatReadPhase.Ready &&
                    it.detail?.cancellationRecoveryPending == true
            ) {
                Text(stringResource(R.string.controls_recovering))
                TextButton(
                    onClick = { model.refreshRecovery(threadId) },
                    enabled = !controls.offline,
                ) {
                    Text(stringResource(R.string.controls_check))
                }
            }
        }
    }
}
