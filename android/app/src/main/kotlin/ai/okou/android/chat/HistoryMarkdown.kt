package ai.okou.android.chat

import ai.okou.android.BuildConfig
import ai.okou.android.R
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.artifacts.ExternalImagePreviewPrefix
import ai.okou.android.artifacts.InlineArtifactImages
import ai.okou.android.artifacts.artifactHttpsUrl
import ai.okou.android.artifacts.icon
import ai.okou.android.artifacts.inlineImageSource
import ai.okou.android.artifacts.label
import ai.okou.android.artifacts.messageArtifactLink
import ai.okou.android.workspaceSearchFocusOutline
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.AbstractVisitor
import org.commonmark.node.BlockQuote
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.LinkReferenceDefinition
import org.commonmark.node.ListBlock
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MarkdownText
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.IncludeSourceSpans
import org.commonmark.parser.Parser

internal data class ChatArtifactActions(
    val open: (link: String, focusKey: String) -> Unit,
    val restoreKey: String?,
    val restored: () -> Unit,
    val images: InlineArtifactImages? = null,
    val threadId: String = "",
    val restoreReply: () -> Unit = restored,
    val openImages: ((ChatImageVisit, String) -> Unit)? = null,
    val openInlineImage: ((String, String) -> Unit)? = null,
)

internal val MessageArtifactCardSpacing = 8.dp
internal val HistoryMarkdownBlockSpacing = 12.dp
private val MarkdownTableCellPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)

internal fun imageFocusReply(focusKey: String?): String? =
    focusKey?.takeIf { it.startsWith("image/") }?.substringAfter('/')?.substringBefore('/')

private fun imageFocusKey(messageBlock: String, path: String, source: String?) =
    "image/$messageBlock/$path/${source.hashCode()}"

internal fun HistoryMessage.replyImagePages(
    interactiveLinks: Boolean,
): List<Pair<String, ChatImagePage>> = blocks.flatMapIndexed { index, block ->
    block
        .artifactMarkdownBlocks()
        .indexedImages()
        .mapNotNull { (path, image) ->
            val source = image.source ?: return@mapNotNull null
            if (
                (interactiveLinks && image.outerLink?.let(::conversationLink) != null) ||
                    image.outerLink?.let(::messageArtifactLink)?.startsWith("/artifacts/") == true
            )
                return@mapNotNull null
            imageFocusKey("$id/$index", path, source) to ChatImagePage(source, image.description)
        }
        .toList()
}

/** Lay out the first visible reply with formatting and keep it while the next chunk is parsed. */
@Composable
internal fun HistoryMarkdown(
    source: String,
    style: TextStyle,
    artifacts: ChatArtifactActions?,
    messageId: String,
    artifactTurnKey: String,
    highlight: ConversationFindHighlight? = null,
    links: ConversationLinkActions? = null,
    compactReply: Boolean = false,
    beforeParsedLayout: (() -> Unit)? = null,
    code: ConversationCodeBody? = null,
) =
    key(messageId, artifacts != null, artifacts?.images != null, links != null, code != null) {
        val inlineImages = artifacts?.images != null
        val blocks =
            rememberMarkdownLayout(source, beforeParsedLayout) {
                historyMarkdownBlocks(
                    it,
                    artifactCards = artifacts != null,
                    interactiveLinks = links != null,
                    inlineImages = inlineImages,
                    showCode = code != null,
                )
            }
        val hit = highlight?.target?.markdownBlockPath?.let(blocks::availableBlockPath)
        val whole = highlight.takeIf { hit == null }
        val findImage =
            highlight?.target?.markdownImage?.takeIf { path ->
                blocks.indexedImages().any { it.first == path }
            }
        val restore =
            (artifacts?.restoreKey ?: links?.restoreKey)?.takeIf {
                it.startsWith("image/$messageId/")
            }
        if (restore != null) {
            LaunchedEffect(restore, blocks) {
                if (
                    blocks.indexedImages().none { (path, image) ->
                        imageFocusKey(messageId, path, image.source) == restore
                    }
                )
                    artifacts?.restoreReply?.invoke()
            }
        }
        val returningCode =
            code?.reader?.returning?.target?.takeIf {
                it.messageId == code.messageId && it.bodyIndex == code.index
            }
        if (code != null && returningCode != null) {
            LaunchedEffect(returningCode, blocks) {
                val restored = blocks.codeAt(returningCode.path)
                if (restored == null || restored.source.lineCount <= ConversationCodePreviewLines) {
                    code.restoreReply()
                }
            }
        }
        HistoryMarkdownBlocks(
            blocks,
            if (whole?.target?.highlighted == true)
                style.copy(color = MaterialTheme.colorScheme.onSecondaryContainer)
            else style,
            artifacts,
            messageId,
            artifactTurnKey,
            Modifier.conversationFindHighlight(whole),
            hit.takeIf { findImage == null },
            highlight,
            links,
            compactReply,
            findImage,
            code = code,
        )
    }

/** The first layout is needed during composition. Later updates can reuse its geometry. */
@Composable
internal fun <Input, Layout> rememberMarkdownLayout(
    input: Input,
    beforeUpdate: (() -> Unit)? = null,
    render: (Input) -> Layout,
): Layout {
    var rendered by remember { mutableStateOf(input to render(input)) }
    val onBeforeUpdate by rememberUpdatedState(beforeUpdate)
    LaunchedEffect(input) {
        if (rendered.first == input) return@LaunchedEffect
        val layout = withContext(Dispatchers.Default) { render(input) }
        onBeforeUpdate?.invoke()
        rendered = input to layout
    }
    return rendered.second
}

@Composable
private fun HistoryMarkdownBlocks(
    blocks: List<HistoryMarkdownBlock>,
    style: TextStyle,
    artifacts: ChatArtifactActions?,
    focusPrefix: String,
    artifactTurnKey: String,
    modifier: Modifier = Modifier,
    hit: String? = null,
    highlight: ConversationFindHighlight? = null,
    links: ConversationLinkActions? = null,
    compactReply: Boolean = false,
    findImage: String? = null,
    path: String = "",
    messageBlock: String = focusPrefix,
    code: ConversationCodeBody? = null,
) {
    val showCards = artifacts != null && !compactReply
    Column(modifier) {
        for ((index, block) in blocks.withIndex()) {
            val previousEndsWithCard =
                showCards && blocks.getOrNull(index - 1)?.endsWithCard == true
            val spacing =
                if (previousEndsWithCard && block.startsWithCard) MessageArtifactCardSpacing
                else HistoryMarkdownBlockSpacing
            val blockPath = "$path$index"
            val selected = highlight.takeIf { blockPath == hit }
            val blockModifier =
                (if (index == 0) Modifier else Modifier.padding(top = spacing))
                    .conversationFindHighlight(selected)
            val highlighted = selected?.target?.highlighted == true
            val contentStyle =
                if (highlighted) style.copy(color = MaterialTheme.colorScheme.onSecondaryContainer)
                else style
            when (block) {
                is HistoryMarkdownBlock.Code ->
                    if (code != null)
                        ConversationCodeCard(
                            block.source,
                            code.reader,
                            ConversationCodeTarget(code.messageId, code.index, blockPath),
                            blockModifier,
                        )
                is HistoryMarkdownBlock.Quote ->
                    Row(blockModifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("│", style = contentStyle)
                        HistoryMarkdownBlocks(
                            block.blocks,
                            contentStyle,
                            artifacts,
                            "$focusPrefix/$index",
                            artifactTurnKey,
                            Modifier.weight(1f),
                            hit,
                            highlight,
                            links,
                            compactReply,
                            findImage,
                            "$blockPath/",
                            messageBlock,
                            code,
                        )
                    }
                is HistoryMarkdownBlock.Table ->
                    HistoryMarkdownTable(
                        block.rows,
                        blockModifier,
                        highlighted,
                        "$focusPrefix/$index",
                        links,
                        artifacts,
                        blockPath,
                        hit,
                        findImage,
                        highlight,
                        messageBlock,
                    )
                is HistoryMarkdownBlock.ListItems ->
                    Column(blockModifier) {
                        for ((itemIndex, item) in block.items.withIndex()) {
                            val afterCard =
                                showCards &&
                                    block.items.getOrNull(itemIndex - 1)?.endsWithCard == true
                            val beforeCard = showCards && item.startsWithCard
                            val adjacentImage =
                                item.blocks.firstOrNull()?.startsWithImage() == true ||
                                    block.items
                                        .getOrNull(itemIndex - 1)
                                        ?.blocks
                                        ?.lastOrNull()
                                        ?.endsWithImage() == true
                            val itemSpacing =
                                when {
                                    afterCard && beforeCard -> MessageArtifactCardSpacing
                                    afterCard || beforeCard || adjacentImage ->
                                        HistoryMarkdownBlockSpacing
                                    else -> 6.dp
                                }
                            Row(
                                if (itemIndex == 0) Modifier
                                else Modifier.padding(top = itemSpacing),
                                horizontalArrangement = Arrangement.spacedBy(7.dp),
                            ) {
                                Text(
                                    item.marker,
                                    Modifier.widthIn(min = 16.dp),
                                    style = contentStyle,
                                )
                                HistoryMarkdownBlocks(
                                    item.blocks,
                                    contentStyle,
                                    artifacts,
                                    "$focusPrefix/$index/$itemIndex",
                                    artifactTurnKey,
                                    Modifier.weight(1f),
                                    hit = hit,
                                    links = links,
                                    compactReply = compactReply,
                                    findImage = findImage,
                                    highlight = highlight,
                                    path = "$blockPath/$itemIndex/",
                                    messageBlock = messageBlock,
                                    code = code,
                                )
                            }
                        }
                    }
                is HistoryMarkdownBlock.Paragraph -> {
                    val blockStyle =
                        when {
                            block.heading == 0 -> contentStyle
                            compactReply -> contentStyle.copy(fontWeight = FontWeight.Bold)
                            block.heading == 1 ->
                                contentStyle.copy(
                                    fontSize = 20.sp,
                                    lineHeight = 28.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            block.heading in 2..6 ->
                                contentStyle.copy(
                                    fontSize = 16.sp,
                                    lineHeight = 24.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            else -> contentStyle
                        }
                    HistoryMarkdownContent(
                        block.content,
                        blockStyle,
                        "$focusPrefix/$index",
                        links,
                        blockModifier,
                        artifacts,
                        artifactTurnKey.takeIf { showCards },
                        imageScope = ImageFocusScope(messageBlock, blockPath, findImage, highlight),
                    )
                }
            }
        }
    }
}

private data class ImageFocusScope(
    val messageBlock: String,
    val path: String,
    val findImage: String?,
    val highlight: ConversationFindHighlight?,
)

@Composable
private fun HistoryMarkdownContent(
    content: HistoryMarkdownContent,
    style: TextStyle,
    focusPrefix: String,
    links: ConversationLinkActions?,
    modifier: Modifier,
    artifacts: ChatArtifactActions?,
    artifactTurnKey: String? = null,
    alignment: TextAlign? = null,
    imageScope: ImageFocusScope,
) {
    val text = content.text
    val inserts =
        remember(content, artifactTurnKey) {
            (content.images + content.cards.takeIf { artifactTurnKey != null }.orEmpty()).sortedBy {
                it.start
            }
        }
    if (inserts.isEmpty()) {
        ConversationLinkText(text, style, "$focusPrefix/0", links, modifier, alignment)
        return
    }
    Column(modifier) {
        var start = 0
        var previous: MarkdownInsert? = null
        for (insert in inserts) {
            val before = text.subSequence(start, insert.start)
            if (before.isNotBlank()) {
                if (previous != null) Spacer(Modifier.height(HistoryMarkdownBlockSpacing))
                ConversationLinkText(
                    before,
                    style,
                    "$focusPrefix/$start",
                    links,
                    alignment = alignment,
                )
                Spacer(Modifier.height(HistoryMarkdownBlockSpacing))
            } else if (previous != null) {
                Spacer(
                    Modifier.height(
                        if (previous is MarkdownCard && insert is MarkdownCard)
                            MessageArtifactCardSpacing
                        else HistoryMarkdownBlockSpacing,
                    ),
                )
            }
            when (insert) {
                is MarkdownCard ->
                    MessageArtifactCard(
                        text.text.substring(insert.start, insert.end),
                        insert.link,
                        checkNotNull(artifactTurnKey),
                        checkNotNull(artifacts),
                    )
                is MarkdownImage -> {
                    val imagePath = "${imageScope.path}/${insert.ordinal}"
                    key(insert.ordinal, insert.source) {
                        ConversationInlineImage(
                            insert.description,
                            insert.source,
                            insert.outerLink,
                            imageFocusKey(imageScope.messageBlock, imagePath, insert.source),
                            checkNotNull(artifacts),
                            links,
                            imageScope.highlight.takeIf { imageScope.findImage == imagePath },
                        )
                    }
                }
            }
            start = insert.end
            previous = insert
        }
        val after = text.subSequence(start, text.length)
        if (after.isNotBlank()) {
            Spacer(Modifier.height(HistoryMarkdownBlockSpacing))
            ConversationLinkText(after, style, "$focusPrefix/$start", links, alignment = alignment)
        }
    }
}

@Composable
internal fun MessageArtifactCard(
    title: String,
    link: String,
    turnKey: String,
    actions: ChatArtifactActions,
) {
    val focusKey = "$turnKey/artifact/$link"
    val restoreFocus = actions.restored.takeIf { actions.restoreKey == focusKey }
    val kind =
        when {
            link.startsWith("https://") -> ArtifactKind.Website
            link.endsWith(".pptx") -> ArtifactKind.Presentation
            link.substringAfterLast('.') in setOf("png", "jpg", "jpeg", "webp", "gif") ->
                ArtifactKind.Image
            link.substringAfterLast('.') in setOf("mp4", "webm", "mov") -> ArtifactKind.Video
            else -> ArtifactKind.File
        }
    val shape = RoundedCornerShape(16.dp)
    val colors = MaterialTheme.colorScheme
    val focus = remember { FocusRequester() }
    val restore =
        if (restoreFocus == null) Modifier
        else
            Modifier.focusRequester(focus).onGloballyPositioned {
                if (focus.requestFocus()) restoreFocus()
            }
    Surface(shape = shape, border = BorderStroke(1.dp, colors.outlineVariant)) {
        Row(
            Modifier.fillMaxWidth()
                .focusProperties { canFocus = true }
                .then(restore)
                .heightIn(min = 60.dp)
                .clip(shape)
                .workspaceSearchFocusOutline(shape)
                .clickable(role = Role.Button) { actions.open(link, focusKey) }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val leading =
                if (kind == ArtifactKind.Image || kind == ArtifactKind.Video)
                    Modifier.size(32.dp).background(colors.surfaceVariant, RoundedCornerShape(8.dp))
                else Modifier.size(20.dp)
            Box(leading, contentAlignment = Alignment.Center) {
                Icon(painterResource(kind.icon()), null, Modifier.size(20.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    title,
                    style =
                        MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            fontWeight = FontWeight.SemiBold,
                        ),
                )
                Text(
                    stringResource(kind.label()),
                    style =
                        MaterialTheme.typography.bodySmall.copy(
                            fontSize = 12.sp,
                            lineHeight = 16.sp,
                        ),
                    color = colors.onSurfaceVariant,
                )
            }
            Icon(
                painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

private sealed interface HistoryMarkdownBlock {
    val startsWithCard: Boolean
        get() = false

    val endsWithCard: Boolean
        get() = false

    data class Paragraph(val content: HistoryMarkdownContent, val heading: Int) :
        HistoryMarkdownBlock {
        val text
            get() = content.text

        val cards
            get() = content.cards

        override val startsWithCard =
            cards.firstOrNull()?.let { card ->
                val firstContent = text.text.indexOfFirst { !it.isWhitespace() }
                firstContent < 0 || firstContent >= card.start
            } == true
        override val endsWithCard =
            cards.lastOrNull()?.let { card ->
                text.text.indexOfLast { !it.isWhitespace() } < card.end
            } == true
    }

    data class Table(val rows: List<List<HistoryMarkdownCell>>) : HistoryMarkdownBlock

    data class Code(val source: ConversationCodeSource) : HistoryMarkdownBlock

    data class Quote(val blocks: List<HistoryMarkdownBlock>) : HistoryMarkdownBlock

    data class ListItems(val items: List<HistoryMarkdownListItem>) : HistoryMarkdownBlock {
        override val startsWithCard = items.firstOrNull()?.startsWithCard == true
        override val endsWithCard = items.lastOrNull()?.endsWithCard == true
    }
}

private sealed interface MarkdownInsert {
    val start: Int
    val end: Int
}

private data class MarkdownCard(override val start: Int, override val end: Int, val link: String) :
    MarkdownInsert

private data class MarkdownImage(
    override val start: Int,
    override val end: Int,
    val ordinal: Int,
    val source: String?,
    val description: String,
    val outerLink: String?,
) : MarkdownInsert

private data class HistoryMarkdownContent(
    val text: AnnotatedString,
    val images: List<MarkdownImage> = emptyList(),
) {
    val cards =
        text.getStringAnnotations("artifact", 0, text.length).map {
            MarkdownCard(it.start, it.end, it.item)
        }

    fun startsWithImage() = images.firstOrNull()?.start?.let { text.take(it).isBlank() } == true

    fun endsWithImage() = images.lastOrNull()?.end?.let { text.drop(it).isBlank() } == true
}

private data class HistoryMarkdownCell(
    val content: HistoryMarkdownContent,
    val alignment: TextAlign,
)

private data class HistoryMarkdownListItem(
    val marker: String,
    val blocks: List<HistoryMarkdownBlock>,
) {
    val startsWithCard = blocks.firstOrNull()?.startsWithCard == true
    val endsWithCard = blocks.lastOrNull()?.endsWithCard == true
}

private fun HistoryMarkdownBlock.startsWithImage(): Boolean =
    when (this) {
        is HistoryMarkdownBlock.Paragraph -> content.startsWithImage()
        is HistoryMarkdownBlock.ListItems ->
            items.firstOrNull()?.blocks?.firstOrNull()?.startsWithImage() == true
        is HistoryMarkdownBlock.Code,
        is HistoryMarkdownBlock.Quote,
        is HistoryMarkdownBlock.Table -> false
    }

private fun HistoryMarkdownBlock.endsWithImage(): Boolean =
    when (this) {
        is HistoryMarkdownBlock.Paragraph -> content.endsWithImage()
        is HistoryMarkdownBlock.ListItems ->
            items.lastOrNull()?.blocks?.lastOrNull()?.endsWithImage() == true
        is HistoryMarkdownBlock.Code,
        is HistoryMarkdownBlock.Quote,
        is HistoryMarkdownBlock.Table -> false
    }

private fun List<HistoryMarkdownBlock>.indexedImages(prefix: String = "") =
    asSequence().flatMapIndexed { index, block -> block.indexedImages("$prefix$index") }

private fun List<HistoryMarkdownBlock>.availableBlockPath(path: String): String? {
    val root = path.substringBefore('/')
    val block = root.toIntOrNull()?.let { getOrNull(it) } ?: return null
    return if (
        path == root ||
            block.indexedContents(root).any { (key, _) -> key == path } ||
            codeAt(path) != null
    )
        path
    else root
}

private fun List<HistoryMarkdownBlock>.codeAt(path: String): HistoryMarkdownBlock.Code? {
    val index = path.substringBefore('/').toIntOrNull() ?: return null
    val rest = path.substringAfter('/', "")
    return when (val block = getOrNull(index)) {
        is HistoryMarkdownBlock.Code -> block.takeIf { rest.isEmpty() }
        is HistoryMarkdownBlock.Quote -> block.blocks.codeAt(rest)
        is HistoryMarkdownBlock.ListItems ->
            rest.substringBefore('/').toIntOrNull()?.let { item ->
                block.items.getOrNull(item)?.blocks?.codeAt(rest.substringAfter('/', ""))
            }
        else -> null
    }
}

private fun HistoryMarkdownBlock.indexedImages(
    path: String,
): Sequence<Pair<String, MarkdownImage>> =
    indexedContents(path).flatMap { (key, content) ->
        content.images.asSequence().map { "$key/${it.ordinal}" to it }
    }

private fun HistoryMarkdownBlock.indexedContents(
    path: String,
): Sequence<Pair<String, HistoryMarkdownContent>> =
    when (this) {
        is HistoryMarkdownBlock.Paragraph -> sequenceOf(path to content)
        is HistoryMarkdownBlock.Code -> emptySequence()
        is HistoryMarkdownBlock.Quote ->
            blocks.asSequence().flatMapIndexed { index, block ->
                block.indexedContents("$path/$index")
            }
        is HistoryMarkdownBlock.ListItems ->
            items.asSequence().flatMapIndexed { itemIndex, item ->
                item.blocks.asSequence().flatMapIndexed { blockIndex, child ->
                    child.indexedContents("$path/$itemIndex/$blockIndex")
                }
            }
        is HistoryMarkdownBlock.Table ->
            rows.asSequence().flatMapIndexed { index, row ->
                row.asSequence().mapIndexed { column, cell ->
                    "$path/$index/$column" to cell.content
                }
            }
    }

private fun HistoryMarkdownBlock.findText(): String =
    when (this) {
        is HistoryMarkdownBlock.Paragraph -> text.text
        is HistoryMarkdownBlock.Code -> source.text
        is HistoryMarkdownBlock.Quote -> blocks.joinToString(" ") { it.findText() }
        is HistoryMarkdownBlock.Table ->
            rows.joinToString(" ") { row -> row.joinToString(" ") { it.content.text.text } }
        is HistoryMarkdownBlock.ListItems ->
            items.joinToString(" ") { item -> item.blocks.joinToString(" ") { it.findText() } }
    }

internal data class MarkdownFindPassage(
    val block: Int,
    val text: String,
    val imagePath: String? = null,
)

internal fun conversationMarkdownFindPassages(
    source: String,
    artifactCards: Boolean,
    imageNames: Map<String, String>,
): List<MarkdownFindPassage> =
    historyMarkdownBlocks(
            source,
            artifactCards,
            interactiveLinks = true,
            inlineImages = artifactCards,
        )
        .flatMapIndexed { index, block ->
            if (block.indexedImages("$index").none())
                listOf(MarkdownFindPassage(index, block.findText()))
            else
                block
                    .indexedContents("$index")
                    .flatMap { (path, content) ->
                        content.findPassages(index, path, imageNames)
                    }
                    .toList()
        }

private fun HistoryMarkdownContent.findPassages(
    index: Int,
    path: String,
    imageNames: Map<String, String>,
): Sequence<MarkdownFindPassage> = sequence {
    var start = 0
    for (image in images) {
        if (start < image.start)
            yield(MarkdownFindPassage(index, text.text.substring(start, image.start)))
        val name = image.source?.let(imageNames::get)
        val description =
            listOfNotNull(image.description.takeIf { it.isNotBlank() }, name)
                .distinct()
                .joinToString(" ")
        yield(MarkdownFindPassage(index, description, "$path/${image.ordinal}"))
        start = image.end
    }
    if (start < text.length) yield(MarkdownFindPassage(index, text.text.substring(start)))
}

private val historyMarkdownExtensions = listOf(TablesExtension.create())

private val historyMarkdownParser = Parser.builder().extensions(historyMarkdownExtensions).build()

private val codeMarkdownParser by lazy {
    Parser.builder()
        .extensions(historyMarkdownExtensions)
        .includeSourceSpans(IncludeSourceSpans.BLOCKS)
        .build()
}

internal fun conversationMarkdownCode(source: String, path: String): ConversationCodeSource? {
    val target =
        path.split('/').fold<String, Node?>(codeMarkdownParser.parse(source)) { parent, index ->
            index.toIntOrNull()?.let { parent?.children()?.elementAtOrNull(it) }
        } as? FencedCodeBlock
    return target?.conversationCodeSource(source.markdownLineEndings())
}

private val workspaceSearchMarkdownParser by lazy {
    Parser.builder()
        .extensions(historyMarkdownExtensions)
        .includeSourceSpans(IncludeSourceSpans.BLOCKS_AND_INLINES)
        .build()
}

internal fun workspaceSearchMarkdownExcerpt(
    source: String,
    ranges: List<IntRange>,
): SearchMessageExcerpt {
    val document = workspaceSearchMarkdownParser.parse(source)
    val orderedRanges = ranges.sortedBy { it.last }
    val first = orderedRanges.firstOrNull()
    val initial = first?.let { document.searchExcerptAt(source, orderedRanges, it) }
    if (first != null) {
        if (initial?.sourceRange == first) return initial
        val readable = document.firstReadableSearchRange(source, orderedRanges)
        if (readable != null) {
            val excerpt = document.searchExcerptAt(source, orderedRanges, readable)
            if (excerpt?.sourceRange == readable) return excerpt
        }
    }
    val context =
        initial?.text
            ?: document
                .children()
                .firstNotNullOfOrNull {
                    it.searchExcerpt(source, emptyList()).text.takeIf(String::isNotBlank)
                }
                .orEmpty()
    return SearchMessageExcerpt(context, emptyList(), first)
}

private fun Node.searchExcerptAt(
    source: String,
    ranges: List<IntRange>,
    anchor: IntRange,
): SearchMessageExcerpt? {
    val (_, block) = workspaceSearchReadingBlock(anchor) ?: return null
    val escapes = block.tablePipeEscapes(source)
    val image = block.markdownImages().containingMatch(anchor, escapes)?.value
    val description = image?.searchExcerpt(source, ranges, escapes)
    if (description != null && description.text.isNotBlank()) return description
    return block.searchExcerpt(source, ranges, escapes).takeIf { it.text.isNotBlank() }
}

internal fun HistoryMessage.workspaceSearchTarget(
    range: IntRange?,
    inlineImages: Boolean,
): ConversationFindTarget {
    if (role != HistoryRole.Assistant || range == null || range.isEmpty() || range.first < 0)
        return ConversationFindTarget(id, null)
    val source =
        blocks.singleOrNull()?.takeIf { it.kind == HistoryBlockKind.Text }?.text
            ?: return ConversationFindTarget(id, null)
    // The index offsets count UTF-16 code units after JavaScript String.trim().
    val prefix = source.indexOfFirst {
        it != '\uFEFF' && (!it.isWhitespace() || it in '\u001C'..'\u001F')
    }
    if (prefix < 0 || range.last >= source.length - prefix) return ConversationFindTarget(id, null)
    val sourceMatch = (prefix + range.first)..(prefix + range.last)
    val document = workspaceSearchMarkdownParser.parse(source)
    val (path, block) =
        document.workspaceSearchReadingBlock(sourceMatch) ?: return ConversationFindTarget(id, null)
    if (block is LinkReferenceDefinition) return ConversationFindTarget(id, null)
    val imagePath =
        if (inlineImages && "![" in source && block !is ListBlock && block !is TableBlock) {
            block
                .markdownImages()
                .containingMatch(sourceMatch, block.tablePipeEscapes(source))
                ?.let { "$path/${it.index}" }
        } else null
    return ConversationFindTarget(id, path, bodyIndex = 0, markdownImage = imagePath)
}

private fun Node.workspaceSearchReadingBlock(range: IntRange): Pair<String, Node>? =
    children().containingMatch(range)?.let { (index, node) ->
        node.matchedReadingBlock(index.toString(), range)
    }

private fun Sequence<Node>.containingMatch(
    range: IntRange,
    escapes: List<Int> = emptyList(),
): IndexedValue<Node>? =
    withIndex().firstOrNull { (_, node) ->
        val spans = node.sourceSpans
        val first = spans.firstOrNull() ?: return@firstOrNull false
        val last = spans.last()
        range.first >= escapes.originalMarkdownIndex(first.inputIndex) &&
            range.last < escapes.originalMarkdownIndex(last.inputIndex + last.length)
    }

private fun Node.matchedReadingBlock(path: String, range: IntRange): Pair<String, Node> {
    when (this) {
        is ListBlock -> {
            val (itemIndex, item) = children().containingMatch(range) ?: return path to this
            val (blockIndex, block) = item.children().containingMatch(range) ?: return path to this
            return block.matchedReadingBlock("$path/$itemIndex/$blockIndex", range)
        }
        is TableBlock -> {
            val (rowIndex, row) = markdownRows().containingMatch(range) ?: return path to this
            val (cellIndex, cell) =
                row.markdownCells().containingMatch(range) ?: return path to this
            return "$path/$rowIndex/$cellIndex" to cell
        }
        else -> return path to this
    }
}

private val artifactMarkdownParser = Parser.builder().build()

private fun historyMarkdownBlocks(
    source: String,
    artifactCards: Boolean,
    interactiveLinks: Boolean,
    inlineImages: Boolean = false,
    showCode: Boolean = false,
): List<HistoryMarkdownBlock> {
    val fenced = showCode && ("~~~" in source || "```" in source)
    val document = (if (fenced) codeMarkdownParser else historyMarkdownParser).parse(source)
    val endings = if (fenced) lazy { source.markdownLineEndings() } else null
    val hasImageSyntax = inlineImages && "![" in source
    val seenArtifacts =
        if (!artifactCards) null
        else if (hasImageSyntax) document.inlineImageArtifacts().toMutableSet() else mutableSetOf()
    return document
        .children()
        .map { it.historyMarkdownBlock(seenArtifacts, interactiveLinks, hasImageSyntax, endings) }
        .toList()
}

private fun Node.containsCodeFence(): Boolean =
    this is FencedCodeBlock || children().any(Node::containsCodeFence)

private fun Node.historyMarkdownBlock(
    seenArtifacts: MutableSet<String>?,
    interactiveLinks: Boolean,
    inlineImages: Boolean,
    lineEndings: Lazy<List<String>>?,
): HistoryMarkdownBlock {
    if (lineEndings != null) {
        if (this is FencedCodeBlock) {
            conversationCodeSource(lineEndings.value)?.let {
                return HistoryMarkdownBlock.Code(it)
            }
        }
        if (this is BlockQuote && containsCodeFence()) {
            return HistoryMarkdownBlock.Quote(
                children()
                    .map {
                        it.historyMarkdownBlock(
                            seenArtifacts,
                            interactiveLinks,
                            inlineImages,
                            lineEndings,
                        )
                    }
                    .toList(),
            )
        }
    }
    return when (this) {
        is TableBlock ->
            HistoryMarkdownBlock.Table(historyMarkdownRows(this, interactiveLinks, inlineImages))
        is ListBlock -> {
            val startNumber = (this as? OrderedList)?.markerStartNumber
            HistoryMarkdownBlock.ListItems(
                children()
                    .mapIndexed { index, item ->
                        val marker = if (startNumber == null) "•" else "${startNumber + index}."
                        HistoryMarkdownListItem(
                            marker,
                            item
                                .children()
                                .map {
                                    it.historyMarkdownBlock(
                                        seenArtifacts,
                                        interactiveLinks,
                                        inlineImages,
                                        lineEndings,
                                    )
                                }
                                .toList(),
                        )
                    }
                    .toList(),
            )
        }
        else -> {
            val images = if (inlineImages) mutableListOf<MarkdownImage>() else null
            val rendered =
                renderHistoryMarkdownNode(
                    this,
                    seenArtifacts = seenArtifacts,
                    interactiveLinks = interactiveLinks,
                    images = images,
                )
            HistoryMarkdownBlock.Paragraph(
                HistoryMarkdownContent(
                    rendered.subSequence(0, rendered.text.trimEnd('\n').length),
                    images.orEmpty(),
                ),
                (this as? Heading)?.level ?: 0,
            )
        }
    }
}

private fun Node.children(): Sequence<Node> = generateSequence(firstChild) { it.next }

private fun Node.markdownImages(): Sequence<Image> =
    if (this is Image) sequenceOf(this) else children().flatMap { it.markdownImages() }

private fun Node.inlineImageArtifacts(): Sequence<String> =
    markdownImages().mapNotNull { image ->
        inlineImageSource(image.destination)?.takeIf { it.startsWith("/artifacts/") }
    }

internal data class ReplyArtifact(val link: String, val title: String)

internal data class ReplyArtifactGroup(
    val cards: List<ReplyArtifact> = emptyList(),
    val followsCard: Boolean = false,
)

/** Keep earlier results available when their reply text is collapsed. */
internal fun earlierReplyArtifacts(earlier: List<HistoryMessage>): List<ReplyArtifact> =
    earlier
        .asSequence()
        .flatMap { it.blocks }
        .flatMap { it.artifactMarkdownBlocks() }
        .flatMap { it.artifacts() }
        .distinctBy { it.link }
        .toList()

internal fun List<ReplyArtifact>.afterLatestReply(
    blocks: List<HistoryBlock>,
    interactiveLinks: Boolean,
): ReplyArtifactGroup {
    val latestLinks = mutableSetOf<String>()
    var endsWithCard = false
    for (block in blocks) {
        val markdown = block.artifactMarkdownBlocks(interactiveLinks)
        markdown.asSequence().flatMap { it.artifacts() }.mapTo(latestLinks) { it.link }
        markdown.indexedImages().mapNotNullTo(latestLinks) { it.second.source }
        endsWithCard = markdown.lastOrNull()?.endsWithCard == true
    }
    return ReplyArtifactGroup(filterNot { it.link in latestLinks }, endsWithCard)
}

private fun HistoryBlock.artifactMarkdownBlocks(
    interactiveLinks: Boolean = false,
): List<HistoryMarkdownBlock> =
    if (kind == HistoryBlockKind.Text && ('[' in text || '<' in text))
        historyMarkdownBlocks(
            text,
            artifactCards = true,
            interactiveLinks = interactiveLinks,
            inlineImages = true,
        )
    else emptyList()

private fun HistoryMarkdownBlock.artifacts(): Sequence<ReplyArtifact> =
    when (this) {
        is HistoryMarkdownBlock.Paragraph ->
            cards.asSequence().map {
                ReplyArtifact(it.link, text.text.substring(it.start, it.end))
            }
        is HistoryMarkdownBlock.ListItems ->
            items.asSequence().flatMap { item ->
                item.blocks.asSequence().flatMap { it.artifacts() }
            }
        is HistoryMarkdownBlock.Quote -> blocks.asSequence().flatMap { it.artifacts() }
        is HistoryMarkdownBlock.Code,
        is HistoryMarkdownBlock.Table -> emptySequence()
    }

private fun historyMarkdownRows(
    table: TableBlock,
    interactiveLinks: Boolean,
    inlineImages: Boolean = false,
    replyCopy: ReplyCopy? = null,
): List<List<HistoryMarkdownCell>> =
    table
        .markdownRows()
        .map { row ->
            row.markdownCells()
                .map { cell ->
                    val images = if (inlineImages) mutableListOf<MarkdownImage>() else null
                    HistoryMarkdownCell(
                        HistoryMarkdownContent(
                            renderHistoryMarkdownNode(
                                cell,
                                interactiveLinks = interactiveLinks,
                                images = images,
                                replyCopy = replyCopy,
                            ),
                            images.orEmpty(),
                        ),
                        when (cell.alignment) {
                            TableCell.Alignment.LEFT -> TextAlign.Left
                            TableCell.Alignment.CENTER -> TextAlign.Center
                            TableCell.Alignment.RIGHT -> TextAlign.Right
                            null -> TextAlign.Start
                        },
                    )
                }
                .toList()
        }
        .toList()

private fun TableBlock.markdownRows(): Sequence<Node> = children().flatMap { it.children() }

private fun Node.markdownCells(): Sequence<TableCell> = children().filterIsInstance<TableCell>()

@Composable
private fun HistoryMarkdownTable(
    rows: List<List<HistoryMarkdownCell>>,
    modifier: Modifier,
    highlighted: Boolean,
    focusPrefix: String,
    links: ConversationLinkActions?,
    artifacts: ChatArtifactActions?,
    path: String,
    hit: String?,
    findImage: String?,
    highlight: ConversationFindHighlight?,
    messageBlock: String,
) {
    val columns = rows.firstOrNull()?.size ?: return
    if (columns == 0) return
    val colors = MaterialTheme.colorScheme
    BoxWithConstraints(modifier) {
        val cellWidth = (maxWidth / columns).coerceIn(112.dp, 240.dp)
        val widths =
            List(columns) { column ->
                if (rows.any { it.getOrNull(column)?.content?.images?.isNotEmpty() == true })
                    maxOf(cellWidth, 168.dp)
                else cellWidth
            }
        Surface(
            shape = RoundedCornerShape(12.dp),
            color = if (highlighted) colors.secondaryContainer else colors.background,
            contentColor = if (highlighted) colors.onSecondaryContainer else colors.onSurface,
            border = BorderStroke(1.dp, colors.outlineVariant),
        ) {
            Column(
                Modifier.horizontalScroll(rememberScrollState())
                    .width(widths.fold(0.dp) { total, width -> total + width }),
            ) {
                for ((index, row) in rows.withIndex()) {
                    if (index != 0) HorizontalDivider(color = colors.outlineVariant)
                    Row(
                        if (index == 0 && !highlighted) Modifier.background(colors.surfaceVariant)
                        else Modifier,
                    ) {
                        for ((column, cell) in row.withIndex()) {
                            val cellPath = "$path/$index/$column"
                            val selected = highlight.takeIf { cellPath == hit }
                            val cellStyle =
                                MaterialTheme.typography.bodyMedium.copy(
                                    fontWeight = if (index == 0) FontWeight.SemiBold else null,
                                )
                            HistoryMarkdownContent(
                                cell.content,
                                if (selected?.target?.highlighted == true)
                                    cellStyle.copy(color = colors.onSecondaryContainer)
                                else cellStyle,
                                "$focusPrefix/$index/$column",
                                links,
                                // Reveal the entire cell, including space for the highlight
                                // outline.
                                Modifier.width(widths[column])
                                    .conversationFindHighlight(selected, MarkdownTableCellPadding)
                                    .padding(MarkdownTableCellPadding),
                                artifacts,
                                alignment = cell.alignment,
                                imageScope =
                                    ImageFocusScope(
                                        messageBlock,
                                        cellPath,
                                        findImage,
                                        highlight,
                                    ),
                            )
                        }
                    }
                }
            }
        }
    }
}

internal fun conversationMarkdownForCopy(
    source: String,
    imageLabel: String,
    authorizedImages: Map<String, String> = emptyMap(),
): String {
    val copy = ReplyCopy(imageLabel, authorizedImages)
    val text =
        renderHistoryMarkdownNode(
                historyMarkdownParser.parse(source),
                replyCopy = copy,
            )
            .text
    // Trim block spacing while keeping row separators before trailing empty cells.
    val end = maxOf(text.indexOfLast { it != '\n' } + 1, copy.lastTableEnd)
    return text.substring(0, end)
}

private val tableCellSeparators = Regex("[\\t\\r\\n]+")

private class ReplyCopy(val imageLabel: String, val authorizedNames: Map<String, String>) {
    var lastTableEnd: Int = 0

    fun target(source: String, outer: String?): String? {
        if (outer != null) {
            val artifact = messageArtifactLink(outer)?.takeIf { it.startsWith("/artifacts/") }
            if (artifact != null) return artifact.takeIf { it in authorizedNames }?.let(::webLink)
            return when (val link = conversationLink(outer)) {
                is ConversationLink.Chat -> webLink(outer)
                is ConversationLink.Web -> link.url.stableTarget()
                null -> null
            }
        }
        if (!source.startsWith(ExternalImagePreviewPrefix)) return webLink(source)
        return artifactHttpsUrl(source.removePrefix(ExternalImagePreviewPrefix))?.stableTarget()
    }

    private fun webLink(value: String): String =
        if (value.startsWith('/')) "${BuildConfig.WEB_ORIGIN.trimEnd('/')}$value" else value

    private fun HttpUrl.stableTarget(): String? =
        toString().takeIf { query == null && !encodedPath.startsWith("/cdn-cgi/image/") }
}

internal fun renderHistoryMarkdown(source: String, compactLists: Boolean = false): AnnotatedString {
    val text =
        renderHistoryMarkdownNode(artifactMarkdownParser.parse(source), styleHeadings = true) {
            paragraph ->
            val item = paragraph.parent as? ListItem
            val list = item?.parent as? ListBlock
            val beforeNewBlock = paragraph.next == null && item?.next == null && list?.next != null
            if (compactLists && list?.isTight == true && !beforeNewBlock) "\n" else "\n\n"
        }
    return if (compactLists) text.subSequence(0, text.text.trimEnd('\n').length) else text
}

private fun renderHistoryMarkdownNode(
    node: Node,
    styleHeadings: Boolean = false,
    seenArtifacts: MutableSet<String>? = null,
    interactiveLinks: Boolean = false,
    images: MutableList<MarkdownImage>? = null,
    replyCopy: ReplyCopy? = null,
    paragraphBreak: (Paragraph) -> String = { if (it.parent is ListItem) "\n" else "\n\n" },
): AnnotatedString = buildAnnotatedString {
    val builder = this
    node.accept(
        object : AbstractVisitor() {
            private val listNumbers = mutableMapOf<OrderedList, Int>()
            private var copiedImages = 0

            override fun visit(node: org.commonmark.node.CustomBlock) {
                if (node is TableBlock) {
                    val rows = historyMarkdownRows(node, interactiveLinks, replyCopy = replyCopy)
                    for ((rowIndex, row) in rows.withIndex()) {
                        if (rowIndex > 0) append('\n')
                        for ((index, cell) in row.withIndex()) {
                            if (index > 0) append('\t')
                            val content = cell.content.text
                            if (replyCopy == null) append(content)
                            else append(content.text.replace(tableCellSeparators, " "))
                        }
                    }
                    replyCopy?.lastTableEnd = length
                    append("\n\n")
                } else visitChildren(node)
            }

            override fun visit(node: MarkdownText) {
                append(node.literal)
            }

            override fun visit(node: Paragraph) {
                visitChildren(node)
                append(paragraphBreak(node))
            }

            override fun visit(node: SoftLineBreak) {
                append(" ")
            }

            override fun visit(node: HardLineBreak) {
                append("\n")
            }

            override fun visit(node: StrongEmphasis) {
                pushStyle(SpanStyle(fontWeight = FontWeight.Bold))
                visitChildren(node)
                pop()
            }

            override fun visit(node: Emphasis) {
                pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                visitChildren(node)
                pop()
            }

            override fun visit(node: Code) {
                pushStyle(SpanStyle(fontFamily = FontFamily.Monospace))
                append(node.literal)
                pop()
            }

            override fun visit(node: FencedCodeBlock) {
                code(node.literal)
            }

            override fun visit(node: IndentedCodeBlock) {
                code(node.literal)
            }

            private fun code(text: String) {
                builder.pushStyle(SpanStyle(fontFamily = FontFamily.Monospace))
                builder.append(text)
                builder.pop()
                builder.append("\n")
            }

            override fun visit(node: Heading) {
                if (styleHeadings)
                    pushStyle(
                        SpanStyle(fontWeight = FontWeight.Bold, fontSize = (26 - node.level).sp),
                    )
                visitChildren(node)
                if (styleHeadings) pop()
                append("\n\n")
            }

            override fun visit(node: Link) {
                val start = length
                val imageCount = images?.size ?: 0
                val copyCount = copiedImages
                visitChildren(node)
                if (copiedImages > copyCount) return
                if (images != null && images.size > imageCount) {
                    if (interactiveLinks && conversationLink(node.destination) != null) {
                        var offset = start
                        for (image in images.subList(imageCount, images.size)) {
                            if (offset < image.start)
                                addStringAnnotation(
                                    ConversationLinkAnnotation,
                                    node.destination,
                                    offset,
                                    image.start,
                                )
                            offset = image.end
                        }
                        if (offset < length)
                            addStringAnnotation(
                                ConversationLinkAnnotation,
                                node.destination,
                                offset,
                                length,
                            )
                    }
                    return
                }
                val artifact =
                    if (seenArtifacts != null) messageArtifactLink(node.destination) else null
                if (artifact != null) {
                    if (length == start) append(node.destination)
                    if (seenArtifacts?.add(artifact) == true)
                        addStringAnnotation("artifact", artifact, start, length)
                    return
                }
                if (interactiveLinks && conversationLink(node.destination) != null) {
                    if (length == start) append(node.destination)
                    addStringAnnotation(ConversationLinkAnnotation, node.destination, start, length)
                    return
                }
                append(" (")
                append(node.destination)
                append(")")
            }

            override fun visit(node: Image) {
                if (images != null || replyCopy != null) {
                    val description = node.imageDescription()
                    val outer =
                        generateSequence(node.parent) { it.parent }
                            .filterIsInstance<Link>()
                            .firstOrNull()
                            ?.destination
                    val source = inlineImageSource(node.destination)
                    if (replyCopy != null) {
                        val name = source?.let { replyCopy.authorizedNames[it] }
                        append(description.ifBlank { name ?: replyCopy.imageLabel })
                        if (source != null && name != null) {
                            replyCopy.target(source, outer)?.let { append(" [$it]") }
                        }
                        copiedImages++
                    } else if (images != null) {
                        val start = length
                        append(description.ifBlank { "\uFFFC" })
                        images.add(
                            MarkdownImage(start, length, images.size, source, description, outer),
                        )
                    }
                    return
                }
                visitChildren(node)
                append(" [")
                append(node.destination)
                append("]")
            }

            override fun visit(node: HtmlBlock) {
                append(node.literal)
                append("\n")
            }

            override fun visit(node: HtmlInline) {
                append(node.literal)
            }

            override fun visit(node: BlockQuote) {
                append("│ ")
                visitChildren(node)
            }

            override fun visit(node: ThematicBreak) {
                append("────────\n")
            }

            override fun visit(node: ListItem) {
                val parent = node.parent
                if (parent is OrderedList) {
                    val number = listNumbers[parent] ?: checkNotNull(parent.markerStartNumber)
                    listNumbers[parent] = number + 1
                    append("$number. ")
                } else append("• ")
                visitChildren(node)
            }
        },
    )
}

private fun Node.imageDescription(): String =
    when (this) {
        is MarkdownText -> literal
        is Code -> literal
        is SoftLineBreak,
        is HardLineBreak -> " "
        else -> children().joinToString("") { it.imageDescription() }
    }
