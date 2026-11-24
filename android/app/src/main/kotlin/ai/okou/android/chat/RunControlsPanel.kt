package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.currentWindowSizeDp
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
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
    val presentation: ConversationContent,
) {
    val currentRunId = displayedRunId.takeUnless { it in state.settledRuns[threadId].orEmpty() }
    private val stopIntent = pending.lastOrNull {
        it.kind == RunControlKind.Interrupt && it.targetId == currentRunId
    }
    private val stopPending = stopIntent != null && phase(stopIntent) != RunControlPhase.Retryable
    val storageFailed = state.persistence == RunControlPersistence.Failed

    private val available = !offline && state.journal != null && !storageFailed

    val canStop = currentRunId != null && available && !stopPending

    fun stop() {
        if (!canStop) return
        if (stopIntent == null) model.stop(threadId, listOf(checkNotNull(currentRunId)))
        else model.retry(stopIntent.id)
    }

    fun revoke(eventId: String, preview: ComposerMessagePreview?): (() -> Unit)? {
        if (
            !available ||
                eventId in state.settledQueueInputs[threadId].orEmpty() ||
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

    private fun phase(intent: RunControlIntent) = state.phases.getValue(intent.id)
}

@Composable
internal fun conversationRunControls(
    model: RunControlsModel,
    history: ConversationHistoryModel,
    threadId: String,
    offline: Boolean,
    composer: ChatComposerModel?,
): ConversationRunControls {
    val state by model.uiState.collectAsStateWithLifecycle()
    val historyState by history.uiState.collectAsStateWithLifecycle()
    val output by history.output.state.collectAsStateWithLifecycle()
    val input = composer?.uiState?.collectAsStateWithLifecycle()
    val previews by
        remember(input, threadId) {
            derivedStateOf { input?.value?.messagesFor(threadId).orEmpty() }
        }
    val confirmed = historyState.takeIf { it.thread?.id == threadId }
    val pending = state.journal?.pending.orEmpty().filter { it.threadId == threadId }
    val hiddenQueueInputs =
        state.settledQueueInputs[threadId].orEmpty() +
            pending
                .filter {
                    it.kind == RunControlKind.Revoke &&
                        it.id in state.optimistic &&
                        state.phases[it.id] != RunControlPhase.Retryable
                }
                .map { it.targetId }
    val presentation =
        remember(confirmed?.transcript, output, threadId, previews, hiddenQueueInputs) {
            conversationContent(
                confirmed?.transcript,
                output,
                threadId,
                previews,
                hiddenQueueInputs,
            )
        }
    if (pending.isNotEmpty()) {
        val confirmation = confirmed?.confirmation
        // A successful timeline read can resume verification after an independent read failed.
        LaunchedEffect(model, threadId, offline, confirmation) {
            if (!offline && confirmation != null) model.checkUnknown(threadId)
        }
    }
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
        pending,
        offline,
        presentation,
    )
}

internal val ConversationStopTouchSize = 48.dp

internal class ConversationStopPlacement {
    var inline by mutableStateOf(false)
        private set

    var transferFocusToInline by mutableStateOf<Boolean?>(null)
        private set

    private var focusedInline: Boolean? = null
    private var slotBottom: Float? = null
    private var feedbackTop: Float? = null

    fun reportInlineSlot(bottom: Float?) {
        slotBottom = bottom
        updatePlacement()
    }

    fun reportFeedbackTop(top: Float?) {
        feedbackTop = top
        updatePlacement()
    }

    private fun updatePlacement() {
        val visible = slotBottom?.let { it <= (feedbackTop ?: Float.POSITIVE_INFINITY) } == true
        if (inline == visible) return
        transferFocusToInline = visible.takeIf { focusedInline == inline }
        inline = visible
    }

    fun onFocusChanged(inline: Boolean, focused: Boolean) {
        if (focused) focusedInline = inline else if (focusedInline == inline) focusedInline = null
    }

    fun clearFocusTransfer() {
        transferFocusToInline = null
    }
}

@Composable
internal fun ConversationStopButton(
    controls: ConversationRunControls,
    placement: ConversationStopPlacement,
    inline: Boolean,
) {
    if (!controls.canStop) {
        Spacer(Modifier.size(ConversationStopTouchSize))
        return
    }
    val focus = remember { FocusRequester() }
    val label = stringResource(R.string.controls_stop)
    val transfer = placement.transferFocusToInline == inline
    LaunchedEffect(transfer) {
        if (transfer) {
            focus.requestFocus()
            placement.clearFocusTransfer()
        }
    }
    IconButton(
        onClick = controls::stop,
        modifier =
            Modifier.size(ConversationStopTouchSize)
                .focusRequester(focus)
                .onFocusChanged { placement.onFocusChanged(inline, it.isFocused) }
                .semantics { contentDescription = label },
    ) {
        Icon(painterResource(R.drawable.ic_stop), null, Modifier.size(20.dp))
    }
}

@Composable
internal fun ConversationOffline(short: Boolean) {
    val container = if (short) Modifier else Modifier.fillMaxWidth().heightIn(min = 48.dp)
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier =
            container.padding(
                horizontal = if (short) 4.dp else composerHorizontalInset(currentWindowSizeDp()),
            ),
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
internal fun ConversationControlStorageFailure(retry: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(horizontal = composerHorizontalInset(currentWindowSizeDp())),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.controls_storage_failed),
            Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 20.sp),
        )
        TextButton(
            onClick = retry,
            modifier = Modifier.heightIn(min = 48.dp),
            colors =
                ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        ) {
            Text(stringResource(R.string.retry))
        }
    }
}
