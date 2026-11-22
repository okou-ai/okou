package ai.okou.android.chat

import ai.okou.android.BuildConfig
import ai.okou.android.LocalActivityStatusColor
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
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Rect
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
    val focusColor = LocalActivityStatusColor.current
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
                                            else colors.onSurface,
                                        textDecoration =
                                            if (chat) TextDecoration.None
                                            else TextDecoration.Underline,
                                    ),
                                focusedStyle = SpanStyle(background = focusFill),
                                pressedStyle =
                                    SpanStyle(background = focusColor.copy(alpha = 0.12f)),
                            ),
                        ) {
                            if (chat) focus.saveFocusedChild()
                            latestActions.value.open(link, key)
                        }
                    ) {
                        if (chat) appendInlineContent(ChatLinkIcon, "\u2060")
                        append(text.subSequence(range.start, range.end))
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
                                20.dp.toSp(),
                                16.dp.toSp(),
                                PlaceholderVerticalAlign.TextCenter,
                            )
                        }
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_chat),
                            contentDescription = null,
                            modifier = Modifier.padding(end = 4.dp),
                            tint = colors.onSecondaryContainer,
                        )
                    }
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
        modifier.focusRequester(focus).focusGroup().drawWithContent {
            val measured = layout
            val corner = CornerRadius(4.dp.toPx())
            if (measured != null)
                for (range in chatRanges) {
                    measured.forEachLinkLine(range.start, range.end) { bounds ->
                        drawRoundRect(
                            colors.secondaryContainer,
                            bounds.topLeft,
                            bounds.size,
                            corner,
                        )
                    }
                }
            drawContent()
            // Compose reports the active link style on the measured text. Use its exact range
            // so the focus ring follows a wrapped link without surrounding its paragraph.
            if (measured != null)
                for (span in measured.layoutInput.text.spanStyles) {
                    if (span.item.background != focusFill) continue
                    measured.forEachLinkLine(span.start, span.end) { bounds ->
                        drawRoundRect(
                            focusColor,
                            bounds.topLeft,
                            bounds.size,
                            corner,
                            style = Stroke(2.dp.toPx()),
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

private inline fun TextLayoutResult.forEachLinkLine(start: Int, end: Int, draw: (Rect) -> Unit) {
    val first = getLineForOffset(start)
    val last = getLineForOffset(end - 1)
    for (line in first..last) {
        val from = maxOf(start, getLineStart(line))
        val to = minOf(end, getLineEnd(line, visibleEnd = true))
        if (from < to) draw(getPathForRange(from, to).getBounds())
    }
}
