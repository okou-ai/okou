package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.artifacts.InlineImageRequest
import ai.okou.android.artifacts.InlineImageState
import ai.okou.android.artifacts.InlineImageStatus
import ai.okou.android.artifacts.messageArtifactLink
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onVisibilityChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first

private val imageCorner = 12.dp

@Composable
internal fun ConversationInlineImage(
    alt: String,
    source: String?,
    outerLink: String?,
    focusKey: String,
    artifacts: ChatArtifactActions,
    links: ConversationLinkActions?,
    find: ConversationFindHighlight?,
) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(imageCorner)
    val density = LocalDensity.current
    BoxWithConstraints(
        Modifier.widthIn(max = 240.dp).fillMaxWidth().heightIn(min = 48.dp).aspectRatio(10f / 9),
    ) {
        val frameWidth = maxWidth
        val width = with(density) { frameWidth.roundToPx().coerceIn(1, 2048) }
        val reader = checkNotNull(artifacts.images)
        val state = source?.let {
            val request =
                remember(artifacts.threadId, source, width) {
                    InlineImageRequest(artifacts.threadId, source, width)
                }
            val result by
                remember(reader, request) { reader.observe(request) }
                    .collectAsStateWithLifecycle(initialValue = reader.get(request))
            var visible by remember { mutableStateOf(false) }
            if (visible) {
                DisposableEffect(reader, request) {
                    reader.retainVisible(request)
                    onDispose { reader.releaseVisible(request) }
                }
                LaunchedEffect(reader, request, result == null) {
                    if (result == null) reader.request(request)
                }
            }
            VisibleImage(
                result,
                visible,
                Modifier.onVisibilityChanged(minFractionVisible = 0.01f) { visible = it },
            )
        }
        val status =
            if (source == null) InlineImageStatus.Unavailable
            else state?.result?.status ?: InlineImageStatus.Loading
        val grant = state?.result?.grant
        val bitmap = state?.result?.bitmap
        val imageOpacity by
            animateFloatAsState(
                if (bitmap != null) 1f else 0f,
                animationSpec =
                    if (state?.visible == true && state.result?.newlyLoaded == true)
                        tween(durationMillis = 150, easing = LinearOutSlowInEasing)
                    else snap(),
                label = "Inline image opacity",
            )
        val description = alt.ifBlank { grant?.filename ?: stringResource(R.string.artifact_image) }
        val outerArtifact =
            outerLink?.let(::messageArtifactLink)?.takeIf { it.startsWith("/artifacts/") }
        val outer = outerLink?.let(::conversationLink)
        val action: (() -> Unit)? =
            when {
                grant == null -> null
                outerArtifact != null -> {
                    { artifacts.open(outerArtifact, focusKey) }
                }
                outer != null && links != null -> {
                    { links.open(outer, focusKey) }
                }
                else -> {
                    { (artifacts.openInlineImage ?: artifacts.open)(grant.previewId, focusKey) }
                }
            }
        val opensLink = outerArtifact != null || (outer != null && links != null)
        val externalBadge =
            outerArtifact == null &&
                outer is ConversationLink.Web &&
                links != null &&
                action != null
        val statusLabel =
            when (status) {
                InlineImageStatus.Loading -> stringResource(R.string.inline_image_loading)
                InlineImageStatus.Ready -> null
                InlineImageStatus.MissingThumbnail ->
                    stringResource(R.string.inline_image_no_thumbnail)
                InlineImageStatus.Unavailable -> stringResource(R.string.inline_image_unavailable)
            }
        val actionLabel =
            if (opensLink) stringResource(R.string.inline_image_open_link)
            else stringResource(R.string.inline_image_view_original)
        val showFallbackAction = status == InlineImageStatus.MissingThumbnail && action != null
        val focus = remember { FocusRequester() }
        val keyboardMode = LocalInputModeManager.current.inputMode == InputMode.Keyboard
        var focused by remember { mutableStateOf(false) }
        val restore = artifacts.restoreKey == focusKey || links?.restoreKey == focusKey
        val restored = if (artifacts.restoreKey == focusKey) artifacts.restored else links?.restored
        val reveal = find?.reveal
        var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
        LaunchedEffect(find?.target) {
            if (reveal != null) {
                val bounds = snapshotFlow {
                    coordinates?.takeIf { it.isAttached }
                }
                    .filterNotNull()
                    .first()
                reveal(bounds)
                if (bounds.isAttached) focus.requestFocus()
            }
        }
        // The placeholder and clickable image use different focus nodes.
        val keepFindFocus = remember(action != null) { find != null && focused }
        LaunchedEffect(action != null) {
            if (keepFindFocus) focus.requestFocus()
        }
        LaunchedEffect(restore, action != null, status) {
            if (!restore) return@LaunchedEffect
            if (action != null) {
                snapshotFlow { coordinates?.takeIf { it.isAttached } }.filterNotNull().first()
                if (focus.requestFocus()) restored?.invoke()
            } else if (status != InlineImageStatus.Loading) {
                artifacts.restoreReply()
            }
        }
        val focusOutline = find?.target?.highlighted == true || (focused && keyboardMode)
        val visibility = state?.visibility ?: Modifier
        val activation =
            if (action != null)
                Modifier.clickable(
                    interactionSource = null,
                    indication = ChatPressRipple,
                    role = if (opensLink) null else Role.Button,
                    onClickLabel = actionLabel.takeIf { opensLink || showFallbackAction },
                    onClick = action,
                )
            else if (find != null) Modifier.focusable() else Modifier
        Box(
            Modifier.fillMaxSize()
                .then(visibility)
                .then(
                    if (restore || reveal != null)
                        Modifier.onGloballyPositioned { coordinates = it }
                    else Modifier,
                )
                .then(if (find != null) Modifier.testTag("conversation_find_hit") else Modifier)
                .focusProperties { canFocus = true }
                .focusRequester(focus)
                .onFocusChanged { focused = it.isFocused }
                .drawBehind {
                    if (focusOutline) {
                        val outer = 3.dp.toPx()
                        drawRoundRect(
                            color = colors.onSurface,
                            topLeft = Offset(-outer, -outer),
                            size = Size(size.width + outer * 2, size.height + outer * 2),
                            cornerRadius = CornerRadius(imageCorner.toPx() + outer),
                            style = Stroke(2.dp.toPx()),
                        )
                    }
                }
                .clip(shape)
                .background(colors.surfaceVariant)
                .border(1.dp, colors.outlineVariant, shape)
                .semantics {
                    contentDescription = description
                    if (statusLabel != null) stateDescription = statusLabel
                }
                .then(activation),
            contentAlignment = Alignment.Center,
        ) {
            if (bitmap != null) {
                Image(
                    remember(bitmap) { bitmap.asImageBitmap() },
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize().graphicsLayer { alpha = imageOpacity },
                    contentScale = ContentScale.Fit,
                )
            } else {
                val base = with(density) { 16.sp.toDp() }
                val narrow = frameWidth - 24.dp < base * 10
                val hideDescription = frameWidth - (if (narrow) 16.dp else 24.dp) < base * 6
                Column(
                    Modifier.padding(if (narrow) 8.dp else 12.dp).clearAndSetSemantics {},
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (!narrow)
                        Icon(
                            painterResource(R.drawable.ic_image),
                            null,
                            Modifier.size(20.dp),
                            tint = colors.onSurfaceVariant,
                        )
                    if (!hideDescription)
                        Text(
                            description,
                            style =
                                MaterialTheme.typography.bodyMedium.copy(
                                    fontSize = 14.sp,
                                    lineHeight = 20.sp,
                                    fontWeight = FontWeight.Medium,
                                ),
                            color = colors.onSurfaceVariant,
                            maxLines = if (narrow) 1 else 2,
                            overflow = TextOverflow.Ellipsis,
                            textAlign = TextAlign.Center,
                        )
                    if (statusLabel != null) InlineImageCaption(statusLabel)
                    if (showFallbackAction) InlineImageCaption(actionLabel, isAction = true)
                }
            }
            if (externalBadge) {
                Box(
                    Modifier.align(Alignment.TopEnd)
                        .padding(8.dp)
                        .size(24.dp)
                        .background(colors.surface, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        painterResource(R.drawable.ic_open_in_new),
                        null,
                        Modifier.size(16.dp),
                        tint = colors.onSurface,
                    )
                }
            }
        }
    }
}

private data class VisibleImage(
    val result: InlineImageState?,
    val visible: Boolean,
    val visibility: Modifier,
)

@Composable
private fun InlineImageCaption(label: String, isAction: Boolean = false) {
    Text(
        label,
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
        color =
            if (isAction) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
}
