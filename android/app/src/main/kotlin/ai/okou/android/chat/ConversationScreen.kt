package ai.okou.android.chat

import ai.okou.android.ContentReadProgress
import ai.okou.android.ControlFailureSnackbar
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.rememberContentReadFeedbackAfter
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.updates.updateFocusOutline
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.LayoutBoundsHolder
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.layoutBounds
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal val ConversationContentMaxWidth = 768.dp

private const val TimelineEnd = "conversation_end"
private const val TimelineStart = "conversation_start"
private const val TimelineInitial = "conversation_initial"
private const val TimelineActivity = "conversation_activity"
private val TimelineEndPadding = 16.dp

private data class ConversationActivityRow(
    @StringRes val label: Int,
    val showHeader: Boolean,
    val runId: String?,
) : ConversationTimelineRow {
    override val key = TimelineActivity
}

@Composable
internal fun ConversationRoute(
    model: ConversationHistoryModel,
    threadId: String,
    list: ChatListUiState,
    modifier: Modifier = Modifier,
    visible: Boolean = true,
    composer: ChatComposerModel? = null,
    historyAvailable: Boolean = true,
    controls: ConversationRunControls? = null,
    stopPlacement: ConversationStopPlacement? = null,
    feedback: SnackbarHostState? = null,
    feedbackBottomPadding: Dp = 8.dp,
    restorePaneFocus: (() -> Unit)? = null,
    queueOpen: Boolean = false,
    queuePosition: LazyListState? = null,
    dismissQueue: () -> Unit = {},
    codeReading: ConversationCodeReading? = null,
    readVisit: State<ConversationReadSession?>? = null,
    artifactActions: ChatArtifactActions? = null,
    findTarget: ConversationFindTarget? = null,
    linkPosition: ConversationLinkPosition? = null,
    onLink: ((ConversationLink, ConversationLinkSource) -> Unit)? = null,
    onLinkFocusRestored: () -> Unit = {},
    linkFocusKey: String? = null,
    onLinkUnavailable: (() -> Unit)? = null,
    searchMessageAnchor: SearchMessageAnchor? = null,
    onSearchMessageResolved: (SearchMessageAnchor, Boolean) -> Unit = { _, _ -> },
    onFollowup: ((String) -> Unit)? = null,
    recovery: @Composable (HistoryMessage) -> Unit = { AssistantFailureCard(it.failureReason) },
) {
    // Deferred work must acknowledge this composition's confirmation, never a newer State.value.
    val state = model.uiState.collectAsStateWithLifecycle().value
    val output = model.output.state.collectAsStateWithLifecycle().value
    val input = if (controls == null) composer?.uiState?.collectAsStateWithLifecycle() else null
    val localMessages by
        remember(input, threadId) {
            derivedStateOf { input?.value?.messagesFor(threadId).orEmpty() }
        }
    val thread = state.thread?.takeIf { historyAvailable && it.id == threadId }
    val missing = thread != null && state.phase == HistoryPhase.Missing
    val transcript = state.transcript.takeIf { thread != null }
    val presentation =
        controls?.presentation
            ?: remember(transcript, output, threadId, localMessages) {
                conversationContent(transcript, output, threadId, localMessages, emptySet())
            }
    val content = presentation.messages.takeUnless { missing }.orEmpty()
    val queue = presentation.queue.takeUnless { missing }.orEmpty()
    val hasContent = transcript != null || content.isNotEmpty() || queue.isNotEmpty()
    val firstReadFailed = !hasContent && thread != null && state.initialReadFailed
    val waitingForHistory = historyAvailable && !hasContent && !firstReadFailed && !missing
    val visit =
        (readVisit
                ?: rememberConversationReadVisit(
                    model,
                    threadId,
                    state.generation,
                    visible && historyAvailable,
                ))
            .value
    val activeRun = controls?.currentRunId ?: transcript?.activeRunId
    val execution = transcript?.execution
    val activeMessage =
        remember(content, activeRun) {
            activeRun?.let { runId ->
                content.lastOrNull {
                    it.message.runId == runId &&
                        (it.message.isOutputReply() ||
                            it.message.role == HistoryRole.User ||
                            it.showFeedbackHeader)
                }
            }
        }
    val replying = activeMessage?.message?.isOutputReply() == true
    val animatedReplyId =
        activeMessage
            ?.takeIf {
                visible &&
                    execution == HistoryExecution.Running &&
                    it.summary?.phase == ReplyPhase.Replying &&
                    output.phase != RunOutputPhase.CatchingUp &&
                    controls?.canStop != false
            }
            ?.message
            ?.id
    val activity =
        when (execution) {
            HistoryExecution.Running ->
                if (replying) R.string.conversation_replying else R.string.conversation_processing
            HistoryExecution.Queued -> R.string.conversation_run_queued
            else -> null
        }
    val summarizeRun = activeRun.takeIf {
        execution == HistoryExecution.Running && !missing
    }
    SideEffect { visit?.showRunActivity(summarizeRun) }
    val activityText =
        visit?.activityText?.collectAsStateWithLifecycle()?.value?.takeIf {
            it.runId == summarizeRun
        }
    val completion = presentation.completion.takeIf { !missing && activity == null }
    val incomingTimeline =
        remember(content, activity, activeMessage, completion, activeRun) {
            val messages = content.asReversed()
            buildList<ConversationTimelineRow> {
                addAll(messages)
                if (completion != null) {
                    val index = messages.indexOfFirst { it.key == completion.anchorKey }
                    add(index.coerceAtLeast(0), completion)
                }
                if (activity != null) {
                    // Reverse layout places the status below its owning message.
                    val index =
                        messages.indexOfFirst { it.key == activeMessage?.key }.coerceAtLeast(0)
                    add(
                        index,
                        ConversationActivityRow(
                            activity,
                            !replying && activeMessage?.showFeedbackHeader != true,
                            activeRun,
                        ),
                    )
                }
            }
        }
    val historyRound =
        state.readRound.takeIf {
            transcript != null && state.phase == HistoryPhase.Loading
        }
    var historyProgressShown by remember(model, historyRound) { mutableStateOf(false) }
    val historyStale =
        rememberContentReadFeedbackAfter(
            state.syncProgressDelayMillis.takeIf { historyRound != null },
            historyRound,
        )
    val showHistoryProgress =
        historyRound != null &&
            (historyProgressShown ||
                state.consecutiveReadFailures >= 3 ||
                historyStale &&
                    activity == null &&
                    queue.isEmpty() &&
                    content.none { it.preview?.pendingDelivery != null })
    val window = currentWindowSizeDp()
    val messageInset = if (window.width >= 600) 32.dp else 24.dp
    val linkTarget = linkPosition?.destination
    val searchMessage =
        remember(transcript, searchMessageAnchor) {
            searchMessageAnchor?.let { transcript?.searchMessage(it.sequence) }
        }
    val inlineImages = artifactActions?.images != null
    val requestedSearchTarget =
        if (searchMessage != null && searchMessageAnchor != null) {
            key(searchMessageAnchor, searchMessage, inlineImages) {
                val target by
                    produceState<ConversationFindTarget?>(null) {
                        value =
                            withContext(Dispatchers.Default) {
                                searchMessage.workspaceSearchTarget(
                                    searchMessageAnchor.range,
                                    inlineImages,
                                )
                            }
                    }
                target
            }
        } else null
    var revealedSearchTarget by
        remember(model, threadId) { mutableStateOf<ConversationFindTarget?>(null) }
    val searchTarget =
        if (searchMessageAnchor == null) revealedSearchTarget else requestedSearchTarget
    val readingTarget = findTarget ?: linkTarget ?: searchTarget
    // Keep cached history usable while a failed lookup awaits a retry.
    val waitingForSearch =
        searchMessageAnchor != null &&
            searchTarget == null &&
            !missing &&
            state.phase != HistoryPhase.Failed
    LaunchedEffect(model, thread?.id, searchMessageAnchor) {
        val anchor = searchMessageAnchor ?: return@LaunchedEffect
        if (thread != null && model.searchMessageIsMissing(threadId, anchor.sequence)) {
            revealedSearchTarget = null
            onSearchMessageResolved(anchor, false)
        }
    }
    val searchPositioned = requestedSearchTarget?.positioned == true
    LaunchedEffect(searchMessageAnchor, requestedSearchTarget, searchPositioned) {
        if (searchMessageAnchor != null && requestedSearchTarget != null && searchPositioned) {
            revealedSearchTarget = requestedSearchTarget
            onSearchMessageResolved(searchMessageAnchor, true)
        }
    }
    val targetMessageId =
        remember(readingTarget, content) {
            when {
                readingTarget == null -> null
                !readingTarget.isRun -> readingTarget.id
                else ->
                    content
                        .asSequence()
                        .flatMap { (it.earlier + it.message).asSequence() }
                        .firstOrNull { it.runId == readingTarget.id }
                        ?.id
            }
        }
    key(model, threadId) {
        val position = rememberLazyListState()
        val timelineFocus = remember { FocusRequester() }
        val returningCode = codeReading?.returning?.takeIf { it.threadId == threadId }
        val inputMode = LocalInputModeManager.current
        var queueWasOpen by remember { mutableStateOf(false) }
        LaunchedEffect(queueOpen) {
            if (
                !queueOpen &&
                    queueWasOpen &&
                    queue.isEmpty() &&
                    inputMode.inputMode == InputMode.Keyboard
            )
                timelineFocus.requestFocus()
            queueWasOpen = queueOpen
        }
        val holdTimeline by
            remember(position) {
                derivedStateOf {
                    position.isScrollInProgress &&
                        position.canScrollBackward &&
                        position.firstVisibleRowIsStatus()
                }
            }
        // Compose anchors to the first row's key. If that key is a status row, defer row changes
        // until its message can be re-anchored without cancelling the reader's gesture.
        var presentedTimeline by remember { mutableStateOf(incomingTimeline) }
        val timeline = if (holdTimeline && !missing) presentedTimeline else incomingTimeline
        SideEffect { presentedTimeline = timeline }
        val runningRows =
            if (execution == HistoryExecution.Running) setOf(TimelineActivity) else emptySet()
        val runningFrame = rememberRunningWaveFrame(position, runningRows)
        val scope = rememberCoroutineScope()
        var initialReadingPosition by
            remember(linkPosition) {
                mutableStateOf<ReadingPosition?>(null)
            }
        var positioned by remember(linkPosition, searchTarget) { mutableStateOf(false) }
        var transcriptShown by remember { mutableStateOf(false) }
        var findViewport by remember { mutableStateOf<LayoutCoordinates?>(null) }
        var hasSeenLatest by remember { mutableStateOf(false) }
        var newReply by remember { mutableStateOf(false) }
        val previewId = content.lastOrNull()?.preview?.eventId
        var lastPreviewId by remember { mutableStateOf(previewId) }
        val newestReply =
            remember(content) {
                content
                    .lastOrNull {
                        it.message.role == HistoryRole.Assistant && it.message.blocks.isNotEmpty()
                    }
                    ?.message
                    ?.id
            }
        var lastReply by remember { mutableStateOf<String?>(null) }
        val atEnd by
            remember(position) {
                derivedStateOf {
                    position.layoutInfo.totalItemsCount > 0 && !position.canScrollBackward
                }
            }
        val density = LocalDensity.current
        val jumpDistance = with(density) { 80.dp.roundToPx() }
        // Measure the tail and the nearest four rows, including their message spacing.
        val recentKeys =
            remember(timeline) { listOf(TimelineEnd) + timeline.take(4).map { it.key } }
        val recentSizes = remember(position) { mutableStateMapOf<String, Int>() }
        val pastJumpThreshold by
            remember(position, jumpDistance, recentKeys) {
                derivedStateOf { position.pastEnd(jumpDistance, recentKeys, recentSizes) }
            }
        SideEffect { recentSizes.keys.retainAll(recentKeys.toSet()) }
        LaunchedEffect(model, threadId, linkPosition, returningCode) {
            val source = linkPosition?.source
            initialReadingPosition =
                ReadingPosition(
                    when {
                        returningCode != null -> returningCode.anchor
                        source != null -> source.anchor
                        else -> model.restoreReadingAnchor(threadId)
                    },
                )
        }
        val foundIndex =
            remember(targetMessageId, timeline) {
                if (targetMessageId == null) -1
                else
                    timeline.indexOfFirst {
                        it is ConversationMessage && it.includes(targetMessageId)
                    }
            }
        val pendingFind = readingTarget?.takeUnless { it.positioned }
        val restored = initialReadingPosition
        val restoredAnchor = restored?.anchor.takeUnless { positioned }
        val restoredIndex =
            remember(restoredAnchor, timeline) {
                restoredAnchor?.let { anchor ->
                    timeline.indexOfFirst {
                        it is ConversationMessage && it.includes(anchor.eventId)
                    }
                } ?: -1
            }
        // Keep cached rows readable while an absent target waits for catch-up.
        val waitingForAnchor =
            (pendingFind != null && foundIndex < 0 ||
                restoredAnchor != null && restoredIndex < 0) && state.phase == HistoryPhase.Loading
        val canPosition =
            restored != null &&
                !positioned &&
                !waitingForAnchor &&
                !waitingForSearch &&
                (hasContent || missing)
        val positionOnFirstMeasure =
            canPosition && hasContent && !missing && !transcriptShown && pendingFind == null
        val showTimeline =
            !hasContent ||
                missing ||
                pendingFind != null ||
                transcriptShown ||
                positioned ||
                positionOnFirstMeasure ||
                restored != null && (waitingForAnchor || waitingForSearch)
        val visibleTimeline = if (showTimeline) timeline else emptyList()
        val waitingForTimeline = waitingForHistory || !showTimeline
        val showSkeleton = rememberContentReadSkeleton(awaitingRead = waitingForTimeline)
        val jumpIndex = if (pendingFind == null) -1 else foundIndex
        val row = (if (jumpIndex >= 0) jumpIndex else restoredIndex) + 1
        val offset =
            if (jumpIndex < 0 && restoredIndex >= 0 && restoredAnchor != null)
                with(density) { restoredAnchor.offsetDp.dp.roundToPx() }
            else 0
        if (showTimeline && hasContent && !missing && !transcriptShown) {
            SideEffect {
                if (positionOnFirstMeasure) {
                    // Set the scroll request as the transcript replaces the loading rows.
                    position.requestScrollToItem(row, offset)
                    positioned = true
                }
                transcriptShown = true
            }
        }
        LaunchedEffect(
            linkPosition,
            searchTarget,
            canPosition,
            positionOnFirstMeasure,
            pendingFind,
            jumpIndex,
            row,
            offset,
        ) {
            if (!canPosition || positionOnFirstMeasure) return@LaunchedEffect
            if (pendingFind == null) {
                position.scrollToItem(row, offset)
            } else {
                // A reader's gesture can cancel the scroll without cancelling this entry.
                coroutineScope { launch { position.scrollToItem(row, offset) }.join() }
                if (jumpIndex < 0) pendingFind.finishPositioning()
            }
            positioned = true
        }
        if (onLinkUnavailable != null) {
            val missingLinkTarget =
                positioned && linkTarget != null && readingTarget === linkTarget && foundIndex < 0
            val linkUnavailable = missing || firstReadFailed || missingLinkTarget
            LaunchedEffect(linkUnavailable, linkPosition) {
                if (linkUnavailable) onLinkUnavailable()
            }
        }
        val awaitingFindPosition = foundIndex >= 0 && pendingFind != null
        val revealTarget = pendingFind?.takeIf { positioned && foundIndex >= 0 }
        if (revealTarget != null) {
            val findRowKey = timeline[foundIndex].key
            LaunchedEffect(position, findRowKey) {
                // A folded reply may still be laying out when the reader scrolls away.
                snapshotFlow { position.layoutInfo.visibleItemsInfo.none { it.key == findRowKey } }
                    .first { it }
                revealTarget.finishPositioning()
            }
        }
        val revealFindHit: (suspend (LayoutCoordinates) -> Unit)? =
            if (revealTarget != null) {
                { hit ->
                    try {
                        val viewport = snapshotFlow {
                            findViewport?.takeIf { it.isAttached }
                        }
                            .filterNotNull()
                            .first()
                        if (hit.isAttached) {
                            val bounds = viewport.localBoundingBoxOf(hit, clipBounds = false)
                            val targetTop =
                                (viewport.size.height - bounds.height).coerceAtLeast(0f) / 2f
                            // The timeline scrolls in reverse layout order.
                            position.scrollBy(targetTop - bounds.top)
                        }
                    } finally {
                        revealTarget.finishPositioning()
                    }
                }
            } else null
        LaunchedEffect(readingTarget, pendingFind) {
            if (pendingFind == null) readingTarget?.expireHighlight()
        }
        val readingReady = positioned && !awaitingFindPosition && !waitingForSearch
        LaunchedEffect(positioned, previewId) {
            // A newly submitted local preview is an action in this chat. A restored preview
            // belongs to the original attempt and should leave the restored reading position.
            if (positioned && previewId != null && previewId != lastPreviewId) {
                pendingFind?.finishPositioning()
                position.scrollToItem(0)
            }
            lastPreviewId = previewId
        }
        val latestConfirmed =
            remember(transcript, content) {
                val id =
                    transcript
                        ?.messages
                        ?.lastOrNull {
                            it.visibleInConversation() && it.id !in transcript.pendingInputIds
                        }
                        ?.id
                content.lastOrNull { it.includes(id) }?.key
            }
        val completionAnchor = completion?.anchorKey
        val completingReply = latestConfirmed?.takeIf { it == completionAnchor }
        val latestAtReadingEdge by
            remember(position, latestConfirmed, completionAnchor) {
                derivedStateOf {
                    val laidOut = position.layoutInfo.visibleItemsInfo
                    val latest = laidOut.firstOrNull { it.key == latestConfirmed }
                    when {
                        latest == null && latestConfirmed != null -> false
                        atEnd -> laidOut.any { it.key == TimelineEnd }
                        latest != null && latest.key == completionAnchor ->
                            // Suggestions can fill a short viewport below the newest reply.
                            position.firstVisibleItemIndex < latest.index ||
                                position.firstVisibleItemIndex == latest.index &&
                                    position.firstVisibleItemScrollOffset == 0
                        else -> false
                    }
                }
            }
        val displayedConfirmation =
            state.confirmation.takeIf { readingReady && latestAtReadingEdge }
        LaunchedEffect(visit, displayedConfirmation) {
            displayedConfirmation?.let { visit?.confirmDisplayed(it) }
        }
        SideEffect {
            if (readingReady) {
                if (!atEnd) position.keepMessageWhenStatusMoves(timeline)
                if (visible && latestAtReadingEdge) {
                    hasSeenLatest = true
                    newReply = false
                } else if (
                    (!atEnd || completingReply != null) &&
                        newestReply != null &&
                        newestReply != lastReply
                ) {
                    newReply = true
                }
            }
            lastReply = newestReply
        }
        LaunchedEffect(model, thread?.id, position, readingReady, visible, density) {
            if (!readingReady || !visible || thread == null) return@LaunchedEffect
            snapshotFlow {
                when {
                    position.isScrollInProgress -> null
                    !position.canScrollBackward -> ReadingPosition(null)
                    else ->
                        position.firstVisibleMessage()?.let {
                            ReadingPosition(it.readingAnchor(density))
                        }
                }
            }
                .filterNotNull()
                .collect { model.rememberReadingAnchor(threadId, it.anchor) }
        }
        val revealHiddenReply = atEnd && completingReply != null && !latestAtReadingEdge
        val newReplyUnseen = newReply || (!hasSeenLatest && list.isUnread(threadId))
        val jump =
            when {
                missing || !readingReady -> null
                newReplyUnseen && (position.canScrollBackward || revealHiddenReply) ->
                    R.string.conversation_new_reply
                atEnd || !position.canScrollBackward -> null
                !pastJumpThreshold -> null
                activity != null -> R.string.conversation_view_progress
                else -> R.string.conversation_jump_latest
            }
        val links = onLink?.let { open ->
            ConversationLinkActions(
                { link, key ->
                    val anchor =
                        position
                            .firstVisibleMessage()
                            ?.takeIf { position.canScrollBackward }
                            ?.readingAnchor(density)
                    open(link, ConversationLinkSource(key, anchor))
                },
                linkFocusKey.takeIf { readingReady },
                onLinkFocusRestored,
            )
        }
        val sourceFocus = artifactActions?.restoreKey ?: linkFocusKey
        val imageReply = imageFocusReply(sourceFocus)
        val attachmentMessage = attachmentFocusMessage(sourceFocus)
        val returnMessage = imageReply ?: attachmentMessage
        if (returnMessage != null && readingReady) {
            LaunchedEffect(sourceFocus, visibleTimeline) {
                val index = visibleTimeline.indexOfFirst {
                    it is ConversationMessage && it.includes(returnMessage)
                }
                if (index < 0 && timelineFocus.requestFocus()) {
                    if (artifactActions?.restoreKey != null) artifactActions.restored()
                    else onLinkFocusRestored()
                } else if (
                    index >= 0 &&
                        position.layoutInfo.visibleItemsInfo.none {
                            it.key == visibleTimeline[index].key
                        }
                ) {
                    position.scrollToItem(index + 1)
                }
            }
        }
        val visibleArtifacts =
            if (returnMessage != null && !readingReady) artifactActions?.copy(restoreKey = null)
            else artifactActions
        if (codeReading != null && returningCode != null && readingReady) {
            LaunchedEffect(returningCode, timeline) {
                val index = timeline.indexOfFirst {
                    it is ConversationMessage && it.includes(returningCode.target.messageId)
                }
                if (index < 0) {
                    if (timelineFocus.requestFocus()) codeReading.restored(returningCode)
                } else if (
                    position.layoutInfo.visibleItemsInfo.none { it.key == timeline[index].key }
                ) {
                    position.scrollToItem(index + 1)
                }
            }
        }
        val codeFocus = LocalFocusManager.current
        val codeKeyboard = LocalSoftwareKeyboardController.current
        val code = codeReading?.let { reading ->
            ConversationCodeActions(
                open = { target, previewOffsetPx ->
                    val anchor = position.firstVisibleMessage()?.readingAnchor(density)
                    codeFocus.clearFocus()
                    codeKeyboard?.hide()
                    reading.open(threadId, target, anchor, previewOffsetPx)
                },
                returning = returningCode.takeIf { readingReady },
                restored = reading::restored,
                feedback = { reading.reportFeedback(threadId, it) },
            )
        }
        val contentWidth = Modifier.widthIn(max = ConversationContentMaxWidth)
        val avatarViewport = remember { LayoutBoundsHolder() }
        val currentFeedback = feedback?.currentSnackbarData
        val queueFeedback = feedback?.takeIf {
            queueOpen &&
                !missing &&
                (currentFeedback?.visuals as? ControlFailureSnackbar)?.kind == RunControlKind.Revoke
        }
        val paneFeedbackVisible = currentFeedback != null && queueFeedback == null
        Column(modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                LazyColumn(
                    contentWidth
                        .fillMaxSize()
                        .testTag("conversation")
                        .focusRequester(timelineFocus)
                        .focusable()
                        .then(
                            if (animatedReplyId == null) Modifier
                            else Modifier.layoutBounds(avatarViewport),
                        )
                        .then(
                            if (awaitingFindPosition)
                                Modifier.onGloballyPositioned { findViewport = it }
                            else Modifier,
                        ),
                    state = position,
                    reverseLayout = true,
                    contentPadding =
                        PaddingValues(
                            start = messageInset,
                            end = messageInset,
                            top = 24.dp,
                            bottom = TimelineEndPadding,
                        ),
                    verticalArrangement = Arrangement.spacedBy(0.dp, Alignment.Top),
                ) {
                    // A stable last item anchors the viewport even when a stream grows or the IME
                    // resizes it.
                    item(key = TimelineEnd) {
                        Box(
                            Modifier.fillMaxWidth().onSizeChanged {
                                recentSizes[TimelineEnd] = it.height
                            },
                        )
                    }
                    itemsIndexed(visibleTimeline, key = { _, entry -> entry.key }) { index, entry ->
                        val trackSize =
                            if (index < 4)
                                Modifier.onSizeChanged { recentSizes[entry.key] = it.height }
                            else Modifier
                        when (entry) {
                            is ConversationCompletion ->
                                ConversationCompletionRow(
                                    entry,
                                    trackSize.padding(top = 20.dp),
                                    onFollowup.takeIf { entry.eventId == completion?.eventId },
                                )
                            is ConversationActivityRow ->
                                Column(
                                    trackSize
                                        .fillMaxWidth()
                                        .padding(top = if (entry.showHeader) 20.dp else 8.dp),
                                ) {
                                    if (entry.showHeader) ConversationReplyHeader()
                                    ConversationActivity(
                                        activityText?.takeIf { it.runId == entry.runId }?.text
                                            ?: stringResource(entry.label),
                                        queued = entry.label == R.string.conversation_run_queued,
                                        runningFrame = runningFrame,
                                        controls =
                                            controls.takeIf { it?.currentRunId == entry.runId },
                                        stopPlacement = stopPlacement,
                                    )
                                }
                            is ConversationMessage -> {
                                val highlight =
                                    readingTarget
                                        ?.takeIf { positioned && entry.includes(targetMessageId) }
                                        ?.let {
                                            ConversationFindHighlight(
                                                it,
                                                revealFindHit,
                                                checkNotNull(targetMessageId),
                                            )
                                        }
                                val previous = timeline.getOrNull(index + 1) as? ConversationMessage
                                val statusWithReply =
                                    entry.message.runId != null &&
                                        entry.message.runId == previous?.message?.runId &&
                                        previous.message.isOutputReply() &&
                                        entry.message.status in
                                            listOf("run.failed", "run.cancelled")
                                // Keep a message's lower edge independent of a new reply below it.
                                Column(
                                    trackSize.padding(
                                        top =
                                            when {
                                                index == timeline.lastIndex -> 0.dp
                                                statusWithReply -> 8.dp
                                                else -> 20.dp
                                            },
                                    ),
                                ) {
                                    ConversationMessageRow(
                                        entry,
                                        artifactActions = visibleArtifacts,
                                        findHighlight = highlight,
                                        links = links,
                                        code = code,
                                        animateAvatarIn =
                                            avatarViewport.takeIf {
                                                entry.message.id == animatedReplyId
                                            },
                                        beforeEarlierRepliesResize = {
                                            if (
                                                !awaitingFindPosition &&
                                                    !position.isScrollInProgress
                                            )
                                                position.keepReplyTop(entry.key)
                                        },
                                        failureContent = recovery,
                                    )
                                }
                            }
                        }
                    }
                    if (visibleTimeline.isEmpty()) {
                        item(key = TimelineInitial) {
                            when {
                                missing -> ContentReadFeedback(R.string.history_missing)
                                waitingForTimeline -> if (showSkeleton) ConversationSkeleton()
                                firstReadFailed -> ContentReadFeedback(R.string.history_failed)
                                transcript != null && queue.isEmpty() ->
                                    Text(stringResource(R.string.history_empty))
                            }
                        }
                    } else {
                        // Keep an anchor above the oldest reply, too.
                        item(key = TimelineStart) {}
                    }
                }
                if (positioned && !atEnd && position.canScrollBackward) {
                    Box(
                        contentWidth
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .height(24.dp)
                            .background(
                                Brush.verticalGradient(
                                    listOf(Color.Transparent, MaterialTheme.colorScheme.background),
                                ),
                            ),
                    )
                }
                // The jump and feedback float over the transcript to preserve its reading viewport.
                Column(
                    contentWidth.align(Alignment.BottomCenter).fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    if (jump != null) {
                        val compactJump = window.height < 480
                        val reportJumpPosition =
                            stopPlacement?.let { placement ->
                                DisposableEffect(placement) {
                                    onDispose { placement.reportJumpBounds(null) }
                                }
                                Modifier.onGloballyPositioned {
                                    placement.reportJumpBounds(it.boundsInRoot())
                                }
                            } ?: Modifier
                        Box(
                            Modifier.fillMaxWidth()
                                .padding(
                                    bottom = if (paneFeedbackVisible) 8.dp else 4.dp,
                                    end = if (compactJump) 12.dp else 0.dp,
                                ),
                            contentAlignment =
                                if (compactJump) Alignment.BottomEnd else Alignment.BottomCenter,
                        ) {
                            ConversationJump(
                                jump,
                                modifier = reportJumpPosition,
                                onClick = {
                                    scope.launch {
                                        position.scrollToItem(0)
                                        if (
                                            jump == R.string.conversation_new_reply &&
                                                completingReply != null &&
                                                position.layoutInfo.visibleItemsInfo.none {
                                                    it.key == completingReply
                                                }
                                        ) {
                                            val replyIndex = timeline.indexOfFirst {
                                                it.key == completingReply
                                            }
                                            if (replyIndex >= 0)
                                                position.scrollToItem(replyIndex + 1)
                                        }
                                    }
                                },
                            )
                        }
                    }
                    if (feedback != null && queueFeedback == null) {
                        val reportBounds =
                            if (paneFeedbackVisible && stopPlacement != null) {
                                DisposableEffect(stopPlacement) {
                                    onDispose { stopPlacement.reportFeedbackBounds(null) }
                                }
                                Modifier.onGloballyPositioned {
                                    stopPlacement.reportFeedbackBounds(it.boundsInRoot())
                                }
                            } else Modifier
                        WorkspaceFeedbackHost(
                            feedback,
                            Modifier.padding(bottom = feedbackBottomPadding)
                                .testTag("conversation_feedback"),
                            manageTimeout = false,
                            surfaceModifier = reportBounds,
                            restorePaneFocus = restorePaneFocus,
                        )
                    }
                }
                if (positioned && findTarget != null && foundIndex < 0) {
                    Text(
                        stringResource(R.string.conversation_find_unavailable),
                        contentWidth
                            .align(Alignment.TopCenter)
                            .background(MaterialTheme.colorScheme.surface)
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                            .semantics { liveRegion = LiveRegionMode.Polite },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (showTimeline) {
                    if (showHistoryProgress && visible && !historyProgressShown) {
                        SideEffect { historyProgressShown = true }
                    }
                    key(model, threadId) {
                        ContentReadProgress(
                            R.string.history_syncing,
                            visible = showHistoryProgress,
                            modifier = Modifier.fillMaxWidth().testTag("history_sync_progress"),
                        )
                    }
                }
            }
        }
        if (queueOpen && !missing)
            ConversationQueueModal(
                queue,
                controls,
                queueFeedback,
                queuePosition ?: rememberLazyListState(),
                dismissQueue,
            )
    }
}

private val TimelineFixedKeys =
    setOf(TimelineEnd, TimelineStart, TimelineInitial, TimelineActivity, ConversationCompletionKey)

private data class ReadingPosition(val anchor: ConversationAnchor?)

private fun LazyListState.keepReplyTop(key: String) {
    val reply = layoutInfo.visibleItemsInfo.firstOrNull { it.key == key } ?: return
    // The next item in reverse order starts at the reply's top edge.
    requestScrollToItem(reply.index + 1, -(reply.offset + reply.size))
}

private fun LazyListItemInfo.readingAnchor(density: Density): ConversationAnchor =
    ConversationAnchor(key as String, with(density) { (-offset).toDp().value })

private fun LazyListState.firstVisibleMessage(): LazyListItemInfo? =
    layoutInfo.visibleItemsInfo.firstOrNull { it.key !in TimelineFixedKeys }

private fun LazyListState.firstVisibleRowIsStatus(): Boolean {
    val index = firstVisibleItemIndex
    return layoutInfo.visibleItemsInfo.any { it.index == index && it.key in TimelineFixedKeys }
}

private fun LazyListState.keepMessageWhenStatusMoves(timeline: List<ConversationTimelineRow>) {
    if (isScrollInProgress || !firstVisibleRowIsStatus()) return
    val message = firstVisibleMessage() ?: return
    val newIndex = timeline.indexOfFirst { it.key == message.key } + 1
    // Compose would otherwise anchor to the status row while it moves to a different message.
    if (newIndex > 0 && newIndex != message.index) requestScrollToItem(newIndex, -message.offset)
}

private fun LazyListState.pastEnd(
    threshold: Int,
    newestKeys: List<String>,
    measured: Map<String, Int>,
): Boolean {
    val first = firstVisibleItemIndex
    if (first >= newestKeys.size) return true
    var distance = firstVisibleItemScrollOffset
    for (index in 0 until first) {
        distance += measured[newestKeys[index]] ?: return true
    }
    return distance > threshold
}

@Composable
internal fun rememberConversationReadVisit(
    model: ConversationHistoryModel,
    threadId: String,
    generation: Long,
    visible: Boolean,
): State<ConversationReadSession?> {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state =
        remember(model, threadId, generation) { mutableStateOf<ConversationReadSession?>(null) }
    var visit by state
    DisposableEffect(model, threadId, generation, lifecycle, visible) {
        fun update() {
            if (visible && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                if (visit == null) visit = model.beginVisit(threadId, generation)
            } else {
                visit?.let(model::endVisit)
                visit = null
            }
        }
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer)
        update()
        onDispose {
            lifecycle.removeObserver(observer)
            visit?.let(model::endVisit)
            visit = null
        }
    }
    return state
}

@Composable
private fun ConversationJump(labelId: Int, modifier: Modifier, onClick: () -> Unit) {
    val label = stringResource(labelId)
    val colors = MaterialTheme.colorScheme
    val iconOnly = labelId == R.string.conversation_jump_latest
    Surface(
        onClick = onClick,
        modifier =
            modifier
                .heightIn(min = 48.dp)
                .updateFocusOutline(CircleShape, colors.onSurface)
                .semantics {
                    contentDescription = label
                    if (labelId == R.string.conversation_new_reply)
                        liveRegion = LiveRegionMode.Polite
                }
                .testTag("conversation_jump"),
        shape = CircleShape,
        color = colors.surface,
        contentColor = colors.onSurface,
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.outline),
        shadowElevation = 2.dp,
    ) {
        Row(
            Modifier.padding(
                horizontal = if (iconOnly) 14.dp else 12.dp,
                vertical = if (iconOnly) 0.dp else 8.dp,
            ),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painterResource(R.drawable.ic_arrow_downward),
                null,
                Modifier.size(if (iconOnly) 20.dp else 16.dp),
            )
            if (!iconOnly)
                Text(
                    label,
                    style =
                        MaterialTheme.typography.bodySmall.copy(
                            fontSize = 13.sp,
                            lineHeight = 20.sp,
                        ),
                )
        }
    }
}

@Composable
private fun ConversationSkeleton() {
    val label = stringResource(R.string.history_loading)
    Column(
        Modifier.fillMaxWidth().semantics { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        repeat(2) { turn ->
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                ChatSkeletonBlock(
                    Modifier.align(Alignment.End)
                        .fillMaxWidth(if (turn == 0) .44f else .35f)
                        .height(if (turn == 0) 52.dp else 40.dp),
                    cornerRadius = 16.dp,
                )
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(
                        Modifier.heightIn(min = 48.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ChatSkeletonBlock(Modifier.size(24.dp))
                        ChatSkeletonBlock(Modifier.width(48.dp).height(12.dp))
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ChatSkeletonBlock(Modifier.fillMaxWidth(.72f).height(14.dp))
                        ChatSkeletonBlock(Modifier.fillMaxWidth(.88f).height(14.dp))
                        if (turn == 0) ChatSkeletonBlock(Modifier.fillMaxWidth(.54f).height(14.dp))
                    }
                }
            }
        }
    }
}
