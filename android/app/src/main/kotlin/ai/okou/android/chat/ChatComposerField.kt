package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.api.generated.ComposerWorkflowsItem
import ai.okou.android.artifacts.InlineArtifactImages
import ai.okou.android.connectors.ChatConnectorOptions
import ai.okou.android.connectors.ConnectorAccountTarget
import ai.okou.android.connectors.connectorFeedbackType
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.settings.DefaultModelSettings
import ai.okou.android.state.rememberJournalEditor
import ai.okou.android.workspaceListPaneWidth
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Keep original line breaks in the journal and preserve native selection offsets.
private val CompactDraftDisplay = VisualTransformation { text ->
    val line = text.text.replace('\n', ' ').replace('\r', ' ')
    TransformedText(if (line == text.text) text else AnnotatedString(line), OffsetMapping.Identity)
}

private data class DraftImageRequest(
    val attachment: DraftChatAttachment,
    val restoreKeyboard: Boolean,
    val unavailable: () -> Unit,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChatComposerField(
    model: ChatComposerModel,
    target: ComposerTarget,
    modifier: Modifier = Modifier,
    followup: String? = null,
    onFollowupInserted: () -> Unit = {},
    beforeSend: () -> Unit = {},
    connectorOptions: ChatConnectorOptions? = null,
    manageConnectors: (ConnectorAccountTarget?) -> Unit = {},
    defaultModel: DefaultModelSettings? = null,
    conversationModel: ConversationModelControls? = null,
    conversationSnackbar: SnackbarHostState? = null,
    onOptionsFeedbackInOverlay: (Boolean) -> Unit = {},
    attachmentPicker: ChatAttachmentPicker? = null,
    openUploadedAttachment: ((ChatAttachmentReference) -> Unit)? = null,
    attachmentImages: InlineArtifactImages? = null,
    stopPlacement: ConversationStopPlacement? = null,
    appBarHeight: Dp = 64.dp,
) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val connectorSave = connectorOptions?.let { options ->
        val optionsState = options.state.collectAsStateWithLifecycle()
        remember(optionsState, target.key) {
                derivedStateOf(structuralEqualityPolicy()) {
                    optionsState.value.blockingPhase(target.key)
                }
            }
            .value
    }
    val focus = LocalFocusManager.current
    val entry = state.entry(target)
    val attachments = state.attachments(target)
    val draftKey = state.draftKey(target)
    val input = rememberJournalEditor(state.journal?.let { entry.text }, target.key)
    val window = currentWindowSizeDp()
    val shortWindow = window.height < 480
    val listPaneWidth = workspaceListPaneWidth(window.width, window.height)
    val wide = listPaneWidth != null
    val horizontalInset = composerHorizontalInset(window)
    val bottomInset =
        when {
            shortWindow -> 8.dp
            wide -> ChatPaneBottomInset
            else -> 14.dp
        }
    val colors = MaterialTheme.colorScheme
    val cardShape = RoundedCornerShape(20.dp)
    val label = stringResource(R.string.composer_message)
    val sendLabel = stringResource(R.string.composer_send)
    val connectorStatus = connectorSave?.let { stringResource(it.message()) }
    val textStyle =
        MaterialTheme.typography.bodyLarge.copy(
            color = colors.onSurface,
            fontSize = 16.sp,
            lineHeight = 26.sp,
        )
    val lineHeight = with(LocalDensity.current) { textStyle.lineHeight.toDp() }
    val textPadding = if (shortWindow) 8.dp else 11.dp
    val minimumTextHeight = maxOf(48.dp, lineHeight + textPadding * 2)
    val maximumTextHeight =
        if (shortWindow) minimumTextHeight
        else maxOf(minimumTextHeight, (window.height * 0.3f).dp.coerceIn(48.dp, 160.dp))
    var inputFocused by remember { mutableStateOf(false) }
    val restoreFocusOnResize = remember(shortWindow) { inputFocused }
    val currentShortWindow by rememberUpdatedState(shortWindow)
    val editorFocus = remember(target.key) { FocusRequester() }
    val attachmentOptionsFocus = remember(target.key) { FocusRequester() }
    val latestInput by rememberUpdatedState(input)
    val hasDraft = state.journal != null
    val keyboard = LocalSoftwareKeyboardController.current
    val imeVisible = WindowInsets.isImeVisible
    val workflowCatalog = model.workflowCatalog
    val workflowState =
        workflowCatalog?.state?.collectAsStateWithLifecycle()?.value ?: ComposerWorkflowState()
    val workflowToken =
        if (workflowCatalog != null && inputFocused) input.value.activeWorkflowToken() else null
    var dismissedWorkflowToken by
        remember(target.key, input.value.text) {
            mutableStateOf<WorkflowToken?>(null)
        }
    var workflowAnchor by remember(target.key) { mutableStateOf(IntRect.Zero) }
    var composerBounds by remember(target.key) { mutableStateOf(Rect.Zero) }
    val workflowQuery = workflowToken?.query.orEmpty()
    val workflowCandidates =
        remember(workflowState.snapshot, workflowQuery, workflowToken != null) {
            if (workflowToken == null) WorkflowCandidates()
            else workflowState.snapshot?.candidates(workflowQuery) ?: WorkflowCandidates()
        }
    val workflowPosition = rememberLazyListState()
    var highlightedWorkflow by remember(target.key, workflowToken) { mutableStateOf<String?>(null) }
    val workflowHeight =
        workflowPanelHeight(
            workflowAnchor,
            appBarHeight,
            workflowCandidates.recent.isNotEmpty(),
        )
    val workflowOpen =
        workflowToken != null &&
            workflowToken != dismissedWorkflowToken &&
            workflowHeight != null &&
            conversationSnackbar?.currentSnackbarData == null
    var popupHeight by remember(workflowOpen) { mutableStateOf(0) }
    val popupGap = with(LocalDensity.current) { 8.dp.toPx() }
    LaunchedEffect(workflowOpen, composerBounds, popupHeight, popupGap, stopPlacement) {
        if (workflowOpen && popupHeight > 0) {
            val bottom = composerBounds.top - popupGap
            stopPlacement?.reportWorkflowBounds(
                Rect(composerBounds.left, bottom - popupHeight, composerBounds.right, bottom),
            )
        } else stopPlacement?.reportWorkflowBounds(null)
    }
    DisposableEffect(stopPlacement) {
        onDispose { stopPlacement?.reportWorkflowBounds(null) }
    }
    fun dismissWorkflow() {
        dismissedWorkflowToken = workflowToken
    }
    fun chooseWorkflow(item: ComposerWorkflowsItem, token: WorkflowToken?) {
        val editor = latestInput
        if (token != null && editor.value.activeWorkflowToken() != token) return
        val updated = editor.value.insertWorkflow(item.name, token)
        if (editor.edit(updated)) model.edit(target, updated.text)
    }
    LaunchedEffect(workflowOpen, workflowCatalog) {
        if (workflowOpen) workflowCatalog?.refresh()
    }
    LaunchedEffect(workflowOpen, workflowQuery) {
        if (workflowOpen) workflowPosition.requestScrollToItem(0)
    }
    var keyboardWasVisible by remember(target.key) { mutableStateOf(false) }
    LaunchedEffect(imeVisible) {
        if (keyboardWasVisible && !imeVisible && workflowOpen) dismissWorkflow()
        keyboardWasVisible = imeVisible
    }
    BackHandler(enabled = workflowOpen && !imeVisible, onBack = ::dismissWorkflow)
    val latestAttachments by rememberUpdatedState(attachments)
    var requestedImage by remember(target, draftKey) { mutableStateOf<DraftImageRequest?>(null) }
    var returnImage by remember(target, draftKey) { mutableStateOf<String?>(null) }
    var restoreKeyboard by remember(target, draftKey) { mutableStateOf(false) }
    val imageVisit =
        model.draftImageVisit?.takeIf {
            it.targetKey == target.key && it.draftKey == draftKey
        }
    LaunchedEffect(requestedImage, target.key, draftKey) {
        val request = requestedImage ?: return@LaunchedEffect
        val tapped = request.attachment
        val candidates = latestAttachments.filter { it.staged && it.contentType.isAttachmentImage }
        val readable =
            withContext(Dispatchers.IO) {
                candidates.mapNotNull { image ->
                    val file = model.attachmentFile(image.key)
                    image.key.takeIf { file.isFile && file.canRead() }
                }
            }
        requestedImage = null
        if (latestAttachments.none { it.key == tapped.key }) return@LaunchedEffect
        val start = readable.indexOf(tapped.key)
        if (start >= 0) {
            if (request.restoreKeyboard) keyboard?.hide()
            model.showDraftImages(
                ChatDraftImageVisit(target.key, draftKey, readable, start, request.restoreKeyboard),
            )
        } else if (tapped.reference != null && openUploadedAttachment != null) {
            openUploadedAttachment(tapped.reference)
        } else request.unavailable()
    }
    LaunchedEffect(returnImage, attachments.isEmpty()) {
        if (returnImage != null && attachments.isEmpty()) {
            attachmentOptionsFocus.requestFocus()
            returnImage = null
        }
    }
    LaunchedEffect(restoreKeyboard) {
        if (restoreKeyboard) {
            withFrameNanos {}
            editorFocus.requestFocus()
            keyboard?.show()
            restoreKeyboard = false
        }
    }
    LaunchedEffect(target, followup, hasDraft) {
        if (followup == null || !hasDraft) return@LaunchedEffect
        val editor = latestInput
        val updated = insertConversationFollowup(editor.value.text, followup)
        editor.edit(updated)
        if (updated.text != editor.value.text) model.edit(target, updated.text)
        onFollowupInserted()
        editorFocus.requestFocus()
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, target, lifecycle) {
        fun open() {
            model.open(target)
            model.observe(target)
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) open()
        }
        lifecycle.addObserver(observer)
        open()
        onDispose { lifecycle.removeObserver(observer) }
    }
    val cardOutline = 1.dp
    // The normal outline is drawn inside the measured card, along with the inner padding.
    val cardVerticalPadding = if (wide) cardOutline + 3.dp else 5.dp
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .imePadding()
            .padding(
                start = horizontalInset,
                top = ChatComposerTopInset,
                end = horizontalInset,
                bottom = bottomInset,
            )
            .testTag("chat_composer"),
    ) {
        val textSpace = maxHeight - cardVerticalPadding * 2
        val availableTextHeight =
            minOf(maximumTextHeight, textSpace).coerceAtLeast(minimumTextHeight)
        ComposerScroll(keepEditorAnchored = { inputFocused && textSpace >= minimumTextHeight }) {
            ComposerFeedback(model, target, state, entry)
            Column(
                Modifier.fillMaxWidth()
                    .onGloballyPositioned {
                        val position = it.positionInWindow()
                        val x = position.x.roundToInt()
                        val y = position.y.roundToInt()
                        workflowAnchor = IntRect(x, y, x + it.size.width, y + it.size.height)
                        composerBounds = it.boundsInRoot()
                    }
                    .testTag("chat_input_card")
                    .background(colors.surfaceContainerLow, cardShape)
                    .border(
                        width = if (inputFocused) 2.dp else cardOutline,
                        color = if (inputFocused) colors.primary else colors.outline,
                        shape = cardShape,
                    )
                    .padding(
                        start = 8.dp,
                        top = cardVerticalPadding,
                        end = 6.dp,
                        bottom = cardVerticalPadding,
                    ),
            ) {
                val attachmentContent: @Composable () -> Unit = {
                    ChatDraftAttachments(
                        model,
                        attachments,
                        state.attachmentProgress,
                        reselect = {
                            attachmentPicker?.pick(
                                it.contentType.isAttachmentImage ||
                                    it.contentType.isAttachmentVideo,
                                draftKey,
                                target.key,
                                it.key,
                            )
                        },
                        expanded = shortWindow,
                        openUploaded = openUploadedAttachment,
                        remoteImages = attachmentImages,
                        threadId = target.threadId.orEmpty(),
                        openLocalImage = { attachment, unavailable ->
                            requestedImage =
                                DraftImageRequest(
                                    attachment,
                                    inputFocused && imeVisible,
                                    unavailable,
                                )
                        },
                        restoreImage = returnImage,
                        onImageFocusRestored = { returnImage = null },
                    )
                }
                if (!shortWindow && attachments.isNotEmpty())
                    Box(Modifier.padding(top = 4.dp, bottom = 4.dp)) { attachmentContent() }
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    if (
                        connectorOptions != null ||
                            defaultModel != null ||
                            attachmentPicker != null ||
                            workflowCatalog != null
                    )
                        ChatConnectorOptionsButton(
                            connectorOptions,
                            model,
                            state,
                            target,
                            inputFocused,
                            editorFocus,
                            manageConnectors,
                            defaultModel,
                            conversationModel,
                            conversationSnackbar = conversationSnackbar,
                            onOptionsFeedbackInOverlay = onOptionsFeedbackInOverlay,
                            buttonFocus = attachmentOptionsFocus,
                            attachmentPickerActive = attachmentPicker?.active == true,
                            selectWorkflow =
                                workflowCatalog?.let { { item -> chooseWorkflow(item, null) } },
                            pickAttachment =
                                attachmentPicker?.let { picker ->
                                    { photos ->
                                        picker.pick(photos, draftKey, target.key, null)
                                    }
                                },
                        )
                    if (shortWindow && attachments.isNotEmpty())
                        ChatDraftAttachmentCount(attachments, attachmentContent)
                    // Scroll state saved by Compose belongs to this orientation.
                    key(shortWindow) {
                        BasicTextField(
                            value = input.value,
                            onValueChange = {
                                // A retiring field can clear its selection while focus moves.
                                if (shortWindow == currentShortWindow) {
                                    input.edit(it)
                                    model.edit(target, it.text)
                                }
                            },
                            modifier =
                                Modifier.weight(1f)
                                    .heightIn(
                                        min = minimumTextHeight,
                                        max = availableTextHeight,
                                    )
                                    .focusRequester(editorFocus)
                                    .onFocusChanged { inputFocused = it.isFocused }
                                    .onPreviewKeyEvent { event ->
                                        if (!workflowOpen || event.type != KeyEventType.KeyDown)
                                            return@onPreviewKeyEvent false
                                        val rows = workflowCandidates.rows
                                        val index = rows.indexOfFirst {
                                            it.workflow.id == highlightedWorkflow
                                        }
                                        when (event.key) {
                                            Key.Escape -> dismissWorkflow()
                                            Key.Enter,
                                            Key.NumPadEnter -> {
                                                val item =
                                                    rows.getOrNull(index)
                                                        ?: return@onPreviewKeyEvent false
                                                chooseWorkflow(item.workflow, workflowToken)
                                            }
                                            Key.DirectionDown,
                                            Key.DirectionUp -> {
                                                if (rows.isEmpty()) return@onPreviewKeyEvent false
                                                val next =
                                                    if (event.key == Key.DirectionDown)
                                                        (index + 1) % rows.size
                                                    else if (index <= 0) rows.lastIndex
                                                    else index - 1
                                                highlightedWorkflow = rows[next].workflow.id
                                                val headings =
                                                    if (workflowCandidates.recent.isEmpty()) 0
                                                    else if (next < workflowCandidates.recent.size)
                                                        1
                                                    else 2
                                                val row = next + headings
                                                val viewport = workflowPosition.layoutInfo
                                                if (
                                                    viewport.visibleItemsInfo.none {
                                                        it.index == row &&
                                                            it.offset >=
                                                                viewport.viewportStartOffset &&
                                                            it.offset + it.size <=
                                                                viewport.viewportEndOffset
                                                    }
                                                )
                                                    workflowPosition.requestScrollToItem(row)
                                            }
                                            else -> return@onPreviewKeyEvent false
                                        }
                                        true
                                    }
                                    .testTag("message_input")
                                    .semantics { contentDescription = label },
                            enabled = state.journal != null,
                            textStyle = textStyle,
                            cursorBrush = SolidColor(colors.onSurface),
                            singleLine = shortWindow,
                            visualTransformation =
                                if (shortWindow) CompactDraftDisplay else VisualTransformation.None,
                            decorationBox = { editor ->
                                Box(
                                    Modifier.fillMaxWidth()
                                        .padding(
                                            start = 2.dp,
                                            top = textPadding,
                                            end = 10.dp,
                                            bottom = textPadding,
                                        ),
                                    contentAlignment = Alignment.CenterStart,
                                ) {
                                    if (input.value.text.isEmpty()) {
                                        Text(
                                            label,
                                            modifier = Modifier.clearAndSetSemantics {},
                                            color = colors.onSurfaceVariant,
                                            style = textStyle,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                    editor()
                                }
                            },
                        )
                        if (restoreFocusOnResize) {
                            LaunchedEffect(editorFocus) { editorFocus.requestFocus() }
                        }
                    }
                    FilledIconButton(
                        onClick = {
                            if (connectorOptions?.blocksSend(target) != true) {
                                focus.clearFocus()
                                beforeSend()
                                model.send(target, defaultModel?.state?.value?.options)
                            }
                        },
                        modifier =
                            Modifier.semantics {
                                contentDescription = sendLabel
                                if (connectorStatus != null) stateDescription = connectorStatus
                            },
                        enabled = state.canSend(target) && connectorSave == null,
                        shape = CircleShape,
                        colors =
                            IconButtonDefaults.filledIconButtonColors(
                                containerColor = colors.primary,
                                contentColor = colors.onPrimary,
                                disabledContainerColor = colors.surfaceVariant,
                                disabledContentColor = colors.onSurfaceVariant,
                            ),
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_arrow_upward),
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                if (workflowOpen) {
                    ComposerWorkflowPopup(
                        workflowAnchor,
                        workflowHeight,
                        workflowState,
                        workflowCandidates,
                        workflowPosition,
                        highlightedWorkflow,
                        ::dismissWorkflow,
                        onHeight = { popupHeight = it },
                    ) {
                        chooseWorkflow(it, workflowToken)
                    }
                }
            }
        }
    }
    if (imageVisit != null) {
        key(imageVisit) {
            ChatDraftImageViewer(
                model,
                target,
                imageVisit,
                attachments,
                listPaneWidth?.dp,
            ) {
                model.showDraftImages(null)
                if (imageVisit.restoreKeyboard) restoreKeyboard = true
                else returnImage = imageVisit.keys[imageVisit.start]
            }
        }
    }
}

internal fun insertConversationFollowup(text: String, prompt: String): TextFieldValue {
    var start = text.indexOf(prompt)
    while (start in text.indices) {
        val end = start + prompt.length
        val wholeLines =
            (start == 0 || text[start - 1] == '\n') && (end == text.length || text[end] == '\n')
        if (wholeLines) return TextFieldValue(text, TextRange(start, end))
        start = text.indexOf(prompt, start + 1)
    }
    val separator = if (text.isEmpty() || text.endsWith('\n')) "" else "\n"
    val result = text + separator + prompt
    return TextFieldValue(result, TextRange(result.length))
}

internal val ChatComposerTopInset = 4.dp

internal fun composerHorizontalInset(window: IntSize) =
    when {
        window.height < 480 -> 12.dp
        window.width >= 600 -> 24.dp
        else -> 20.dp
    }

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ComposerScroll(keepEditorAnchored: () -> Boolean, content: @Composable () -> Unit) {
    val scroll = rememberScrollState()
    val anchor = rememberUpdatedState(keepEditorAnchored)
    val defaultSpec = LocalBringIntoViewSpec.current
    val composerSpec =
        remember(scroll, defaultSpec) {
            object : BringIntoViewSpec by defaultSpec {
                override fun calculateScrollDistance(
                    offset: Float,
                    size: Float,
                    containerSize: Float,
                ): Float {
                    // A fitted editor is already visible at the bottom. Read its current focus
                    // because another control may request scrolling before recomposition.
                    if (scroll.value == 0 && anchor.value()) return 0f
                    return defaultSpec.calculateScrollDistance(offset, size, containerSize)
                }
            }
        }
    CompositionLocalProvider(LocalBringIntoViewSpec provides composerSpec) {
        Column(Modifier.verticalScroll(scroll, reverseScrolling = true)) {
            CompositionLocalProvider(LocalBringIntoViewSpec provides defaultSpec, content = content)
        }
    }
}

@Composable
private fun ComposerFeedback(
    model: ChatComposerModel,
    target: ComposerTarget,
    state: ComposerState,
    entry: ComposerEntry,
) {
    val actionColors =
        ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onBackground)
    if (state.journal == null && state.persistence == ComposerPersistence.Failed) {
        Text(stringResource(R.string.composer_local_failed))
        TextButton(
            onClick = { model.open(target) },
            colors = actionColors,
        ) {
            Text(stringResource(R.string.retry))
        }
    }
    state.journal?.manualDrafts(target)?.forEach { (key, text) ->
        val files = state.journal.retainedDraftAttachments[key].orEmpty()
        Text(
            listOf(text)
                .filter { it.isNotEmpty() }
                .plus(files.map { it.filename })
                .joinToString("\n"),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        TextButton(
            onClick = { model.restoreDraft(target, key) },
            enabled = entry.text.isEmpty() && state.attachments(target).isEmpty(),
            colors = actionColors,
        ) {
            Text(stringResource(R.string.composer_restore_draft))
        }
    }
    val busy = target.key in state.busy
    val connectorSetupFailed = state.connectorSetupFailed(target.key)
    if (connectorSetupFailed) {
        Column(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, bottom = 4.dp)) {
            Text(
                stringResource(R.string.chat_connector_first_send_failed),
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = connectorFeedbackType(),
            )
            TextButton(onClick = { model.retry(target) }, enabled = !busy, colors = actionColors) {
                Text(stringResource(R.string.composer_retry))
            }
        }
    } else if (
        entry.pending != null &&
            entry.pending.started == null &&
            (!busy || target.key in state.checking)
    ) {
        FlowRow {
            TextButton(
                onClick = { model.observe(target) },
                enabled = !busy,
                colors = actionColors,
            ) {
                Text(stringResource(R.string.composer_check))
            }
            TextButton(onClick = { model.retry(target) }, enabled = !busy, colors = actionColors) {
                Text(stringResource(R.string.composer_retry))
            }
        }
    }
    if (target.key in state.unobserved) Text(stringResource(R.string.composer_not_observed))
}
