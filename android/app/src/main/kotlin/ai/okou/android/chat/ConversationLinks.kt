package ai.okou.android.chat

import ai.okou.android.BuildConfig
import ai.okou.android.R
import android.content.ActivityNotFoundException
import android.content.Context
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal const val ConversationLinkAnnotation = "conversation-link"

internal sealed interface ConversationLink {
    data class Web(val url: HttpUrl) : ConversationLink

    data class Chat(val threadId: String, val anchor: MessageLinkAnchor?) : ConversationLink
}

internal data class MessageLinkAnchor(val id: String, val isRun: Boolean)

internal data class ConversationLinkSource(val key: String, val anchor: ConversationAnchor?)

internal class ConversationLinkPosition(
    val destination: ConversationFindTarget? = null,
    val source: ConversationLinkSource? = null,
)

private val chatLinkPath =
    Regex("/chats/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/?")
private val appWebOrigin = BuildConfig.WEB_ORIGIN.toHttpUrl()
private val productionWebOrigin = "https://app.okou.ai".toHttpUrl()

internal fun conversationLink(value: String): ConversationLink? {
    if (value.any { it.isWhitespace() || it == '\\' }) return null
    val relative = value.startsWith("/chats/")
    if (
        !relative &&
            (!value.startsWith("https://", ignoreCase = true) &&
                !value.startsWith("http://", ignoreCase = true) ||
                value.substringAfter("://").takeWhile { it !in "/?#" }.contains('@'))
    )
        return null
    val url = if (relative) appWebOrigin.resolve(value) else value.toHttpUrlOrNull()
    if (url == null || url.username.isNotEmpty() || url.password.isNotEmpty()) return null
    val trusted =
        listOf(appWebOrigin, productionWebOrigin).any {
            it.scheme == url.scheme && it.host == url.host && it.port == url.port
        }
    val beforeQuery = value.substringBefore('#').substringBefore('?')
    val path =
        if (relative) beforeQuery
        else beforeQuery.substringAfter("://").substringAfter('/', "").let { "/$it" }
    val threadId = chatLinkPath.matchEntire(path)?.groupValues?.get(1)
    if (trusted && threadId != null) {
        val fragment = url.fragment.orEmpty()
        val isRun = fragment.startsWith("run-")
        val anchor =
            fragment
                .takeIf { isRun || it.startsWith("event-") }
                ?.substringAfter('-')
                ?.takeIf { it.isNotEmpty() }
                ?.let { MessageLinkAnchor(it, isRun) }
        return ConversationLink.Chat(threadId, anchor)
    }
    return ConversationLink.Web(url).takeUnless { relative }
}

internal fun openConversationWebLink(context: Context, link: ConversationLink.Web): Boolean =
    try {
        CustomTabsIntent.Builder().build().launchUrl(context, link.url.toString().toUri())
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }

internal data class ConversationLinkActions(
    val open: (ConversationLink, String) -> Unit,
    val restoreKey: String?,
    val restored: () -> Unit,
)

private const val ChatLinkIcon = "chat-link-icon"
private const val ChatLinkEndInset = "chat-link-end-inset"

@Composable
internal fun ConversationLinkText(
    text: AnnotatedString,
    style: TextStyle,
    key: String,
    actions: ConversationLinkActions?,
    modifier: Modifier = Modifier,
    alignment: TextAlign? = null,
) {
    val annotations =
        remember(text, actions != null) {
            if (actions == null) emptyList()
            else text.getStringAnnotations(ConversationLinkAnnotation, 0, text.length)
        }
    if (actions == null || annotations.isEmpty()) {
        Text(text, modifier, style = style, textAlign = alignment)
        return
    }
    val colors = MaterialTheme.colorScheme
    val focusColor = colors.onSurface
    val focusFill = focusColor.copy(alpha = 0.16f)
    val focus = remember { FocusRequester() }
    val latestActions = rememberUpdatedState(actions)
    val links =
        remember(annotations) {
            annotations.mapNotNull { range -> conversationLink(range.item)?.let { range to it } }
        }
    val rendered =
        remember(text, links, colors, focusColor, key) {
            buildAnnotatedString {
                var start = 0
                for ((range, link) in links) {
                    append(text.subSequence(start, range.start))
                    val chat = link is ConversationLink.Chat
                    withLink(
                        LinkAnnotation.Clickable(
                            if (chat) "chat" else "web",
                            TextLinkStyles(
                                style =
                                    SpanStyle(
                                        color =
                                            if (chat) colors.onSecondaryContainer
                                            else Color.Unspecified,
                                        fontWeight = FontWeight.SemiBold,
                                        textDecoration = TextDecoration.Underline,
                                    ),
                                focusedStyle = SpanStyle(background = focusFill),
                            ),
                        ) {
                            if (chat) focus.saveFocusedChild()
                            latestActions.value.open(link, key)
                        },
                    ) {
                        if (chat) appendInlineContent(ChatLinkIcon, "\u2060")
                        append(text.subSequence(range.start, range.end))
                        if (chat) appendInlineContent(ChatLinkEndInset, "\u2060")
                    }
                    start = range.end
                }
                append(text.subSequence(start, text.length))
            }
        }
    val chatRanges =
        remember(rendered) {
            rendered.getLinkAnnotations(0, rendered.length).filter {
                (it.item as? LinkAnnotation.Clickable)?.tag == "chat"
            }
        }
    var layout by remember(rendered) { mutableStateOf<TextLayoutResult?>(null) }
    val density = LocalDensity.current
    val icons =
        remember(density, colors.onSecondaryContainer) {
            mapOf(
                ChatLinkIcon to
                    InlineTextContent(
                        with(density) {
                            Placeholder(
                                24.dp.toSp(),
                                16.dp.toSp(),
                                PlaceholderVerticalAlign.TextCenter,
                            )
                        },
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_chat),
                            contentDescription = null,
                            modifier = Modifier.padding(horizontal = 4.dp),
                            tint = colors.onSecondaryContainer,
                        )
                    },
                ChatLinkEndInset to
                    InlineTextContent(
                        with(density) {
                            Placeholder(
                                4.dp.toSp(),
                                16.dp.toSp(),
                                PlaceholderVerticalAlign.TextCenter,
                            )
                        },
                    ) {},
            )
        }
    LaunchedEffect(actions.restoreKey, key) {
        if (actions.restoreKey == key) {
            if (!focus.restoreFocusedChild()) focus.requestFocus()
            actions.restored()
        }
    }
    Text(
        rendered,
        modifier.focusRequester(focus).focusGroup().drawWithCache {
            val measured = layout ?: return@drawWithCache onDrawWithContent { drawContent() }
            val corner = CornerRadius(4.dp.toPx())
            val chipHeight = style.fontSize.toPx() + 4.dp.toPx()
            val focusInset = 2.dp.toPx()
            val focusStroke = Stroke(focusInset)
            val chips = buildList {
                for (range in chatRanges) {
                    measured.forEachLinkFragment(range.start, range.end) { bounds ->
                        add(bounds.limitHeight(chipHeight))
                    }
                }
            }
            // Compose reports the active link style on the measured text.
            val outlines = buildList {
                for (span in measured.layoutInput.text.spanStyles) {
                    if (span.item.background != focusFill) continue
                    measured.forEachLinkFragment(span.start, span.end) { bounds ->
                        add(bounds.limitHeight(chipHeight).inflate(focusInset))
                    }
                }
            }
            onDrawWithContent {
                for (chip in chips) {
                    drawRoundRect(colors.secondaryContainer, chip.topLeft, chip.size, corner)
                }
                drawContent()
                for (outline in outlines) {
                    drawRoundRect(
                        focusColor,
                        outline.topLeft,
                        outline.size,
                        corner,
                        style = focusStroke,
                    )
                }
            }
        },
        style = style,
        textAlign = alignment,
        inlineContent = icons,
        onTextLayout = { layout = it },
    )
}

private fun Rect.limitHeight(height: Float): Rect {
    val inset = (this.height - height).coerceAtLeast(0f) / 2
    return Rect(left, top + inset, right, bottom - inset)
}

private inline fun TextLayoutResult.forEachLinkFragment(
    start: Int,
    end: Int,
    draw: (Rect) -> Unit,
) {
    val first = getLineForOffset(start)
    val last = getLineForOffset(end - 1)
    for (line in first..last) {
        val from = maxOf(start, getLineStart(line))
        val to = minOf(end, getLineEnd(line, visibleEnd = true))
        // A selection path ending at a soft wrap can include space on the following line.
        // Combine only adjacent character bounds, including the inline placeholders.
        val boxes =
            (from until to)
                .mapNotNull { getBoundingBox(it).takeIf { box -> box.width > 0 } }
                .sortedBy { it.left }
        var fragment = boxes.firstOrNull() ?: continue
        for (index in 1 until boxes.size) {
            val box = boxes[index]
            if (box.left > fragment.right) {
                draw(fragment)
                fragment = box
            } else {
                fragment = fragment.copy(right = maxOf(fragment.right, box.right))
            }
        }
        draw(fragment)
    }
}
