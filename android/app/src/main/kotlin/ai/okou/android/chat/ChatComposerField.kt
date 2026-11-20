package ai.okou.android.chat

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.state.rememberJournalEditor
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun ChatComposerField(
    model: ChatComposerModel,
    target: ComposerTarget,
    modifier: Modifier = Modifier,
    onInputFocusChanged: (Boolean) -> Unit = {},
) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val focus = LocalFocusManager.current
    val entry = state.entry(target)
    val input = rememberJournalEditor(state.journal?.let { entry.text }, target.key)
    val window = currentWindowSizeDp()
    val shortWindow = window.height < 480
    val horizontalInset =
        when {
            shortWindow -> 12.dp
            window.width >= 600 -> 24.dp
            else -> 20.dp
        }
    val bottomInset =
        when {
            shortWindow -> 8.dp
            window.width >= 840 -> 24.dp
            else -> 14.dp
        }
    val colors = MaterialTheme.colorScheme
    val cardShape = RoundedCornerShape(20.dp)
    val label = stringResource(R.string.composer_message)
    val sendLabel = stringResource(R.string.composer_send)
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
    val cardVerticalPadding = 5.dp
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .imePadding()
            .padding(
                start = horizontalInset,
                top = 4.dp,
                end = horizontalInset,
                bottom = bottomInset,
            )
            .testTag("chat_composer")
    ) {
        val textSpace = maxHeight - cardVerticalPadding * 2
        val availableTextHeight =
            minOf(maximumTextHeight, textSpace).coerceAtLeast(minimumTextHeight)
        ComposerScroll(keepEditorAnchored = { inputFocused && textSpace >= minimumTextHeight }) {
            ComposerFeedback(model, target, state, entry)
            Row(
                Modifier.fillMaxWidth()
                    .background(colors.surface, cardShape)
                    .border(
                        width = if (inputFocused) 2.dp else 1.dp,
                        color =
                            if (inputFocused) LocalActivityStatusColor.current else colors.outline,
                        shape = cardShape,
                    )
                    .padding(
                        start = 8.dp,
                        top = cardVerticalPadding,
                        end = 6.dp,
                        bottom = cardVerticalPadding,
                    ),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                BasicTextField(
                    value = input.value,
                    onValueChange = {
                        input.edit(it)
                        model.edit(target, it.text)
                    },
                    modifier =
                        Modifier.weight(1f)
                            .heightIn(min = minimumTextHeight, max = availableTextHeight)
                            .onFocusChanged {
                                inputFocused = it.isFocused
                                onInputFocusChanged(it.isFocused)
                            }
                            .testTag("message_input")
                            .semantics { contentDescription = label },
                    enabled = state.journal != null,
                    textStyle = textStyle,
                    cursorBrush = SolidColor(colors.onSurface),
                    maxLines = if (shortWindow) 1 else Int.MAX_VALUE,
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
                FilledIconButton(
                    onClick = {
                        focus.clearFocus()
                        model.send(target)
                    },
                    modifier = Modifier.size(48.dp).semantics { contentDescription = sendLabel },
                    enabled = state.canSend(target),
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
        }
    }
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
    if (state.persistence == ComposerPersistence.Failed) {
        Text(stringResource(R.string.composer_local_failed))
        TextButton(
            onClick = { if (state.journal == null) model.open(target) else model.retryLocal() }
        ) {
            Text(stringResource(R.string.retry))
        }
    }
    when (state.sync(target)) {
        ComposerSync.Loading -> Text(stringResource(R.string.composer_sync_loading))
        ComposerSync.Saving -> Text(stringResource(R.string.composer_sync_saving))
        ComposerSync.Failed,
        ComposerSync.Unsupported -> {
            Text(
                stringResource(
                    if (state.sync(target) == ComposerSync.Unsupported)
                        R.string.composer_sync_unsupported
                    else R.string.composer_sync_failed
                )
            )
            TextButton(onClick = { model.retrySync(target) }) {
                Text(stringResource(R.string.composer_sync_retry))
            }
        }
        else -> Unit
    }
    state.journal?.retainedDrafts?.forEach { (key, text) ->
        Text(text, maxLines = 2, overflow = TextOverflow.Ellipsis)
        TextButton(onClick = { model.restoreDraft(target, key) }, enabled = entry.text.isEmpty()) {
            Text(stringResource(R.string.composer_restore_draft))
        }
    }
    if (target.threadId == null && state.context != ComposerContext.Ready) {
        Text(
            stringResource(
                if (state.context == ComposerContext.Loading) R.string.composer_target_loading
                else R.string.composer_target_unavailable
            )
        )
        if (state.context != ComposerContext.Loading)
            TextButton(onClick = { model.open(target) }) { Text(stringResource(R.string.retry)) }
    }
    entry.pending?.let { pending ->
        Text(
            stringResource(R.string.composer_unconfirmed),
            style = MaterialTheme.typography.labelLarge,
        )
        Text(pending.send.prompt, maxLines = 3, overflow = TextOverflow.Ellipsis)
        FlowRow {
            TextButton(onClick = { model.observe(target) }, enabled = target.key !in state.busy) {
                Text(stringResource(R.string.composer_check))
            }
            TextButton(onClick = { model.retry(target) }, enabled = target.key !in state.busy) {
                Text(stringResource(R.string.composer_retry))
            }
        }
    }
    entry.receipt?.let {
        Text(stringResource(it.disposition.label()), modifier = Modifier.testTag("send_receipt"))
        TextButton(onClick = { model.observe(target) }, enabled = target.key !in state.busy) {
            Text(stringResource(R.string.composer_check))
        }
    }
    if (target.key in state.unobserved) Text(stringResource(R.string.composer_not_observed))
    if (target.key in state.failed) Text(stringResource(R.string.composer_request_failed))
    if (state.persistence == ComposerPersistence.Pending)
        Text(stringResource(R.string.composer_saving), style = MaterialTheme.typography.labelSmall)
}

private fun TextDisposition.label() =
    when (this) {
        TextDisposition.Accepted -> R.string.composer_accepted
        TextDisposition.Queued -> R.string.history_queued
        TextDisposition.Consumed -> R.string.composer_consumed
        TextDisposition.Completed -> R.string.history_completed
        TextDisposition.Failed -> R.string.history_run_failed
        TextDisposition.Cancelled -> R.string.history_cancelled
        TextDisposition.Rejected -> R.string.history_rejected
        TextDisposition.Revoked -> R.string.composer_revoked
    }
