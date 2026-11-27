package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.artifacts.InlineArtifactImages
import ai.okou.android.artifacts.InlineImageRequest
import ai.okou.android.artifacts.attachmentPreviewId
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import java.io.File

private const val AttachmentImageAspectRatio = 4f / 3

internal fun attachmentFocusMessage(key: String?): String? =
    key?.takeIf { it.startsWith("chat-attachment/") }?.substringAfter('/')?.substringBefore('/')

internal fun ChatAttachmentReference.matchesAttachmentFocus(
    focus: String?,
    messageId: String,
    index: Int,
): Boolean =
    focus == "chat-attachment/$messageId/$index" || focus == attachmentFocusKey(messageId, index)

private fun ChatAttachmentReference.attachmentFocusKey(messageId: String, index: Int) =
    "chat-attachment/$messageId/$index/$id"

@Composable
internal fun ChatMessageAttachments(
    messageId: String,
    attachments: List<ChatAttachmentReference>,
    actions: ChatArtifactActions?,
    localFiles: Map<String, File>,
) {
    val images = attachments.withIndex().filter { it.value.contentType.isAttachmentImage }
    val files = attachments.withIndex().filterNot { it.value.contentType.isAttachmentImage }
    val openImages = actions?.openImages
    fun openImage(index: Int, key: String) {
        if (actions == null) return
        if (openImages != null) {
            val start = images.indexOfFirst { it.index == index }
            openImages(
                ChatImageVisit(
                    actions.threadId,
                    images.map { (_, file) ->
                        ChatImagePage(
                            file.attachmentPreviewId(),
                            file.filename,
                            localFiles[file.id],
                        )
                    },
                    start,
                ),
                key,
            )
        } else actions.open(attachments[index].attachmentPreviewId(), key)
    }
    val shape = RoundedCornerShape(8.dp)
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxWidth().testTag("chat-message-attachments"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (images.size == 1) {
            val (index, image) = images.single()
            ChatAttachmentImage(
                image,
                actions?.images,
                actions?.threadId.orEmpty(),
                localFiles[image.id],
                Modifier.attachmentAction(messageId, index, image, actions) { openImage(index, it) }
                    .align(Alignment.CenterHorizontally)
                    .widthIn(max = 180.dp * AttachmentImageAspectRatio)
                    .fillMaxWidth()
                    .aspectRatio(AttachmentImageAspectRatio),
            )
        } else {
            images.chunked(2).forEach { row ->
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    row.forEach { (index, image) ->
                        ChatAttachmentImage(
                            image,
                            actions?.images,
                            actions?.threadId.orEmpty(),
                            localFiles[image.id],
                            Modifier.attachmentAction(messageId, index, image, actions) {
                                    openImage(index, it)
                                }
                                .weight(1f)
                                .heightIn(max = 160.dp)
                                .aspectRatio(AttachmentImageAspectRatio),
                        )
                    }
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
        files.forEach { (index, file) ->
            Row(
                Modifier.fillMaxWidth()
                    .clip(shape)
                    .background(colors.surface)
                    .border(1.dp, colors.outlineVariant, shape)
                    .attachmentAction(messageId, index, file, actions)
                    .heightIn(min = 48.dp)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    painterResource(attachmentIcon(file.contentType)),
                    null,
                    Modifier.size(20.dp),
                    tint = colors.onSurfaceVariant,
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        file.filename,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        attachmentSummary(file.contentType, file.size),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun Modifier.attachmentAction(
    messageId: String,
    index: Int,
    attachment: ChatAttachmentReference,
    actions: ChatArtifactActions?,
    open: ((String) -> Unit)? = null,
): Modifier {
    if (actions == null) return this
    val key = attachment.attachmentFocusKey(messageId, index)
    val focus = remember { FocusRequester() }
    val restoration =
        if (attachment.matchesAttachmentFocus(actions.restoreKey, messageId, index))
            Modifier.focusRequester(focus).onGloballyPositioned {
                if (focus.requestFocus()) actions.restored()
            }
        else Modifier
    return then(restoration).clickable(role = Role.Button) {
        if (open == null) actions.open(attachment.attachmentPreviewId(), key) else open(key)
    }
}

@Composable
internal fun ChatAttachmentImage(
    file: ChatAttachmentReference,
    images: InlineArtifactImages?,
    threadId: String,
    localFile: File?,
    modifier: Modifier,
    describe: Boolean = true,
) {
    var localFailed by remember(localFile) { mutableStateOf(false) }
    BoxWithConstraints(
        Modifier.clip(RoundedCornerShape(8.dp))
            .then(modifier)
            .then(
                if (describe) Modifier.semantics { contentDescription = file.filename }
                else Modifier,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (localFile != null && !localFailed) {
            AsyncImage(
                localFile,
                null,
                Modifier.matchParentSize(),
                contentScale = ContentScale.Fit,
                onError = { localFailed = true },
            )
            return@BoxWithConstraints
        }
        val image =
            if (images == null) null
            else {
                val width = with(LocalDensity.current) { maxWidth.roundToPx() }.coerceAtLeast(1)
                val source = remember(file) { file.attachmentPreviewId() }
                val request =
                    remember(threadId, source, width) {
                        InlineImageRequest(threadId, source, width)
                    }
                val state by
                    remember(images, request) { images.observe(request) }
                        .collectAsStateWithLifecycle(images.get(request))
                DisposableEffect(images, request) {
                    images.retainVisible(request)
                    onDispose { images.releaseVisible(request) }
                }
                LaunchedEffect(images, request, state == null) {
                    if (state == null) images.request(request)
                }
                state?.bitmap
            }
        if (image != null)
            Image(
                image.asImageBitmap(),
                null,
                Modifier.matchParentSize(),
                contentScale = ContentScale.Fit,
            )
        else
            Icon(
                painterResource(R.drawable.ic_image),
                null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
    }
}
