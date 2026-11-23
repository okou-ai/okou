package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.currentWindowSizeDp
import androidx.annotation.StringRes
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
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
    displayedRunId: String?,
    val pending: List<RunControlIntent>,
    val offline: Boolean,
) {
    val settledQueueInputs = state.settledQueueInputs[threadId].orEmpty()
    private val stopSettled = displayedRunId in state.settledRuns[threadId].orEmpty()
    val currentRunId = displayedRunId.takeUnless { stopSettled }
    val stopIntent = pending.lastOrNull {
        it.kind == RunControlKind.Interrupt && it.targetId == currentRunId
    }
    val stopPhase = stopIntent?.let(::phase)
    val suppressRunActivity = stopSettled || stopPhase.awaitingOutcome()
    val recoveryPending = confirmed?.detail?.cancellationRecoveryPending == true
    val settledNotice =
        state.notice?.takeIf {
            it.threadId == threadId && it.kind == RunControlNoticeKind.TargetSettled
        }

    fun detachedIntents(queueIds: Set<String>) = pending.filterNot {
        it == stopIntent || it.kind == RunControlKind.Revoke && it.targetId in queueIds
    }

    val hasFeedback =
        state.persistence == RunControlPersistence.Failed ||
            pending.isNotEmpty() ||
            settledNotice != null ||
            recoveryPending

    private val available =
        !offline && state.journal != null && state.persistence != RunControlPersistence.Failed

    val canStop = currentRunId != null && available && !stopPhase.awaitingOutcome()

    fun stop() {
        if (!canStop) return
        if (stopIntent == null) model.stop(threadId, listOf(checkNotNull(currentRunId)))
        else model.retry(stopIntent.id)
    }

    fun revoke(eventId: String, preview: ComposerMessagePreview?): (() -> Unit)? {
        if (
            !available ||
                eventId in settledQueueInputs ||
                !confirmed.canWithdrawInput(threadId, eventId, preview)
        )
            return null
        val intent = withdrawal(eventId)
        return when {
            intent == null -> ({ model.skip(threadId, eventId, preview) })
            phase(intent) == RunControlPhase.Retryable -> ({ model.retry(intent.id) })
            else -> null
        }
    }

    private fun withdrawal(eventId: String) = pending.firstOrNull {
        it.kind == RunControlKind.Revoke && it.targetId == eventId
    }

    fun phase(intent: RunControlIntent) = state.phases.getValue(intent.id)

    fun withdrawalPhase(eventId: String) = withdrawal(eventId)?.let(::phase)

    fun checkWithdrawal(eventId: String) = withdrawal(eventId)?.let(::check)

    fun check(intent: RunControlIntent): (() -> Unit)? =
        if (
            available &&
                phase(intent) == RunControlPhase.Unknown &&
                pending.none { phase(it) == RunControlPhase.Checking }
        )
            ({ model.checkIntent(threadId, intent.id) })
        else null

    fun canRetry(intent: RunControlIntent) = available && phase(intent) == RunControlPhase.Retryable
}

private fun RunControlPhase?.awaitingOutcome() = this != null && this != RunControlPhase.Retryable

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
    showStop: Boolean = true,
) {
    val stop = controls?.takeIf { showStop && it.currentRunId != null }
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
        return
    }

    val phase = controls?.stopPhase
    if (!offline && stop == null && phase == null) return
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(horizontal = composerHorizontalInset(currentWindowSizeDp())),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (phase != null) {
            ControlStatusText(stopStatus(phase), Modifier.weight(1f))
        } else {
            if (offline) ConversationOffline(short = false)
            Spacer(Modifier.weight(1f))
        }
        if (phase == RunControlPhase.Unknown) {
            val action = controls.stopIntent?.let(controls::check)
            ControlTextAction(R.string.controls_check, action)
        } else if (stop != null && !phase.awaitingOutcome()) {
            TextButton(
                onClick = stop::stop,
                enabled = stop.canStop,
                modifier = Modifier.heightIn(min = 48.dp),
                colors =
                    ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.onSurface,
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
internal fun ConversationControlNotes(controls: ConversationRunControls, queueIds: Set<String>) {
    val pending = controls.detachedIntents(queueIds)
    val storageFailed = controls.state.persistence == RunControlPersistence.Failed
    if (
        pending.isEmpty() &&
            !storageFailed &&
            controls.settledNotice == null &&
            !controls.recoveryPending
    )
        return
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = composerHorizontalInset(currentWindowSizeDp())),
    ) {
        if (storageFailed) {
            ControlNote(
                R.string.controls_storage_failed,
                R.string.retry,
                controls.model::retryLocal,
            )
        }
        for (intent in pending) {
            val phase = controls.phase(intent)
            val label =
                when (intent.kind) {
                    RunControlKind.Interrupt -> stopStatus(phase)
                    RunControlKind.Revoke -> withdrawalStatus(phase, automation = false)
                }
            when (phase) {
                RunControlPhase.Unknown ->
                    ControlNote(label, R.string.controls_check, controls.check(intent))
                RunControlPhase.Retryable ->
                    ControlNote(
                        label,
                        R.string.controls_retry_original,
                        if (controls.canRetry(intent)) ({ controls.model.retry(intent.id) })
                        else null,
                    )
                else -> ControlNote(label)
            }
        }
        controls.settledNotice?.let {
            ControlNote(
                if (it.operation == RunControlKind.Interrupt) R.string.controls_run_ended
                else R.string.controls_input_left_queue,
            )
        }
        if (controls.recoveryPending) {
            if (controls.confirmed?.detailPhase == ChatReadPhase.Failed) {
                ControlNote(
                    R.string.controls_recovery_failed,
                    R.string.retry,
                    if (controls.offline) null
                    else ({ controls.model.refreshRecovery(controls.threadId) }),
                )
            } else {
                ControlNote(R.string.controls_recovering)
            }
        }
    }
}

@StringRes
private fun stopStatus(phase: RunControlPhase) =
    when (phase) {
        RunControlPhase.Preparing,
        RunControlPhase.Sending -> R.string.controls_stopping
        RunControlPhase.Accepted -> R.string.controls_stop_accepted
        RunControlPhase.Checking -> R.string.controls_stop_checking
        RunControlPhase.Unknown -> R.string.controls_stop_unknown
        RunControlPhase.Retryable -> R.string.controls_stop_failed
    }

@StringRes
internal fun withdrawalStatus(phase: RunControlPhase, automation: Boolean) =
    when (phase) {
        RunControlPhase.Unknown ->
            if (automation) R.string.conversation_skip_unknown
            else R.string.conversation_withdraw_unknown
        RunControlPhase.Retryable ->
            if (automation) R.string.conversation_skip_failed
            else R.string.conversation_withdraw_failed
        RunControlPhase.Checking -> R.string.controls_checking_result
        else ->
            if (automation) R.string.conversation_skipping else R.string.conversation_withdrawing
    }

@Composable
private fun ControlNote(
    @StringRes label: Int,
    @StringRes actionLabel: Int? = null,
    action: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ControlStatusText(label, Modifier.weight(1f))
        if (actionLabel != null) ControlTextAction(actionLabel, action)
    }
}

@Composable
internal fun ControlTextAction(@StringRes label: Int, action: (() -> Unit)?) {
    TextButton(
        onClick = { action?.invoke() },
        enabled = action != null,
        modifier = Modifier.heightIn(min = 48.dp),
        colors =
            ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(
            stringResource(label),
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 20.sp),
        )
    }
}

@Composable
private fun ControlStatusText(@StringRes label: Int, modifier: Modifier) {
    Text(
        stringResource(label),
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 20.sp),
    )
}
