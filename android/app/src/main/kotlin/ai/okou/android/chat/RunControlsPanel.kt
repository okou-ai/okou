package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.updates.updateFocusOutline
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
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
    val presentation: ConversationContent,
) {
    val currentRunId = displayedRunId.takeUnless { it in state.settledRuns[threadId].orEmpty() }
    private val stopIntent = pending.lastOrNull {
        it.kind == RunControlKind.Interrupt && it.targetId == currentRunId
    }
    private val stopPending = stopIntent != null && phase(stopIntent) != RunControlPhase.Retryable
    val canStop = currentRunId != null && !stopPending

    fun stop() {
        if (!canStop) return
        if (stopIntent == null) model.stop(threadId, listOf(checkNotNull(currentRunId)))
        else model.retry(stopIntent.id)
    }

    fun revoke(eventId: String, preview: ComposerMessagePreview?): (() -> Unit)? {
        if (
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
    val pending = state.pending.filter { it.threadId == threadId }
    val hiddenQueueInputs =
        state.settledQueueInputs[threadId].orEmpty() +
            pending
                .filter {
                    it.kind == RunControlKind.Revoke &&
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
        LaunchedEffect(model, threadId, confirmation) {
            if (confirmation != null) model.checkUnknown(threadId)
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
    private var slotBounds: Rect? = null
    private var feedbackBounds: Rect? = null
    private var jumpBounds: Rect? = null
    var contentCoordinates: LayoutCoordinates? = null
    private var workflowComposerBounds: Rect? = null
    private var dismissWorkflow: (() -> Unit)? = null
    var workflowBounds by mutableStateOf<Rect?>(null)
        private set

    fun reportWorkflowBounds(bounds: Rect?) {
        workflowBounds = bounds
        updatePlacement()
    }

    fun registerWorkflowDismissal(composer: Rect?, dismiss: (() -> Unit)?) {
        workflowComposerBounds = composer
        dismissWorkflow = dismiss
    }

    fun onContentPress(position: Offset) {
        val dismiss = dismissWorkflow ?: return
        val coordinates = contentCoordinates?.takeIf { it.isAttached } ?: return
        if (workflowComposerBounds?.contains(coordinates.localToRoot(position)) == false) dismiss()
    }

    fun reportInlineSlot(bounds: Rect?) {
        slotBounds = bounds
        updatePlacement()
    }

    fun reportFeedbackBounds(bounds: Rect?) {
        feedbackBounds = bounds
        updatePlacement()
    }

    fun reportJumpBounds(bounds: Rect?) {
        jumpBounds = bounds
        updatePlacement()
    }

    private fun updatePlacement() {
        val target = slotBounds
        val visible =
            target != null &&
                feedbackBounds?.overlaps(target) != true &&
                jumpBounds?.overlaps(target) != true &&
                workflowBounds?.overlaps(target) != true
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
    val colors = IconButtonDefaults.iconButtonColors()
    if (inline && !placement.inline) {
        // Keep the glyph in the scrolling row while the toolbar owns the usable action.
        Box(Modifier.size(ConversationStopTouchSize), contentAlignment = Alignment.Center) {
            StopGlyph(colors.contentColor)
        }
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
        colors = colors,
        modifier =
            Modifier.size(ConversationStopTouchSize)
                .focusRequester(focus)
                .onFocusChanged { placement.onFocusChanged(inline, it.isFocused) }
                .updateFocusOutline(CircleShape, MaterialTheme.colorScheme.onSurface)
                .semantics { contentDescription = label },
    ) {
        StopGlyph(colors.contentColor)
    }
}

@Composable
private fun StopGlyph(tint: Color) {
    Icon(painterResource(R.drawable.ic_stop_circle), null, Modifier.size(20.dp), tint)
}
