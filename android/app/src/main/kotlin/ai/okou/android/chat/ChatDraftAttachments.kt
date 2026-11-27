package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.artifacts.InlineArtifactImages
import ai.okou.android.connectors.ConnectorSheet
import ai.okou.android.state.rememberDraftAttachmentPreview
import ai.okou.android.state.rememberDraftAttachmentsOpen
import android.content.ActivityNotFoundException
import android.content.Intent
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts.CreateDocument
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import coil3.compose.AsyncImage
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ChatAttachmentFileProvider : FileProvider()

@Composable
internal fun ChatDraftAttachments(
    model: ChatComposerModel,
    attachments: List<DraftChatAttachment>,
    progress: Map<String, Int>,
    reselect: (DraftChatAttachment) -> Unit,
    expanded: Boolean,
    openUploaded: ((ChatAttachmentReference) -> Unit)?,
    remoteImages: InlineArtifactImages?,
    threadId: String,
    openLocalImage: (DraftChatAttachment, () -> Unit) -> Unit,
    restoreImage: String?,
    onImageFocusRestored: () -> Unit,
) {
    var previewKey by rememberDraftAttachmentPreview()
    val preview = attachments.firstOrNull { it.key == previewKey }
    val panelFocus = remember { FocusRequester() }
    val fallbackFocus =
        if (restoreImage != null && attachments.none { it.key == restoreImage })
            Modifier.focusRequester(panelFocus).focusable().onGloballyPositioned {
                if (panelFocus.requestFocus()) onImageFocusRestored()
            }
        else Modifier
    LazyRow(
        Modifier.fillMaxWidth().then(fallbackFocus).testTag("chat-draft-attachments"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(attachments, key = { it.key }) { attachment ->
            val local = attachment.takeIf { it.staged }?.let { model.attachmentFile(it.key) }
            ChatDraftAttachmentCard(
                attachment,
                progress[attachment.key],
                local,
                expanded,
                remoteImages,
                threadId,
                open = {
                    if (local != null && attachment.contentType.isAttachmentImage)
                        openLocalImage(attachment) { previewKey = attachment.key }
                    else previewKey = attachment.key
                },
                restoreFocus = restoreImage == attachment.key,
                onFocusRestored = onImageFocusRestored,
                recover = {
                    when (attachment.failure) {
                        AttachmentFailure.SourceUnavailable -> reselect(attachment)
                        AttachmentFailure.UploadFailed ->
                            if (attachment.staged) model.retryAttachment(attachment.key)
                            else reselect(attachment)
                        else -> Unit
                    }
                },
                remove = { model.removeAttachment(attachment.key) },
            )
        }
    }
    if (preview != null) {
        key(preview.key) {
            val file = model.attachmentFile(preview.key)
            val cached by
                produceState<Boolean?>(null, file, preview.staged) {
                    value = preview.staged && withContext(Dispatchers.IO) { file.isFile }
                }
            val reference = preview.reference
            if (cached == false && reference != null && openUploaded != null) {
                LaunchedEffect(reference, openUploaded) {
                    previewKey = null
                    openUploaded(reference)
                }
            } else {
                cached?.let { available ->
                    DraftAttachmentPreview(preview, file, available) { previewKey = null }
                }
            }
        }
    }
}

@Composable
internal fun ChatDraftAttachmentCount(
    attachments: List<DraftChatAttachment>,
    content: @Composable () -> Unit,
) {
    var shown by rememberDraftAttachmentsOpen()
    val count = attachments.size
    if (count == 0) return
    val label = stringResource(R.string.chat_attachment_count, count)
    val color =
        if (attachments.any { it.failure != null }) MaterialTheme.colorScheme.error
        else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier.size(48.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(role = Role.Button) { shown = true }
            .semantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_folder), null, Modifier.size(18.dp), tint = color)
        Text(count.toString(), style = MaterialTheme.typography.bodySmall, color = color)
    }
    if (shown)
        ConnectorSheet(
            title = stringResource(R.string.chat_attachments),
            dismiss = { shown = false },
            expandInShortWindow = true,
            back = { shown = false },
            actions = {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { shown = false }) {
                        Text(stringResource(R.string.chat_attachment_done))
                    }
                }
            },
        ) {
            content()
        }
}

@Composable
private fun ChatDraftAttachmentCard(
    attachment: DraftChatAttachment,
    percent: Int?,
    local: File?,
    expanded: Boolean,
    remoteImages: InlineArtifactImages?,
    threadId: String,
    open: () -> Unit,
    restoreFocus: Boolean,
    onFocusRestored: () -> Unit,
    recover: () -> Unit,
    remove: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val card =
        Modifier.clip(shape)
            .background(colors.surface)
            .border(1.dp, colors.outlineVariant, shape)
            .testTag("chat-draft-attachment")
    val status =
        when (attachment.failure) {
            AttachmentFailure.TooLarge -> stringResource(R.string.chat_attachment_too_large)
            AttachmentFailure.SourceUnavailable -> stringResource(R.string.chat_attachment_reselect)
            AttachmentFailure.UploadFailed -> stringResource(R.string.chat_attachment_failed)
            null ->
                when {
                    attachment.reference != null ->
                        attachmentSummary(attachment.contentType, attachment.size)
                    percent != null -> stringResource(R.string.chat_attachment_uploading, percent)
                    else -> stringResource(R.string.chat_attachment_waiting)
                }
        }
    val recoverable =
        attachment.failure == AttachmentFailure.UploadFailed ||
            attachment.failure == AttachmentFailure.SourceUnavailable
    val summaryColor = if (attachment.failure == null) colors.onSurfaceVariant else colors.error
    val removeLabel = stringResource(R.string.chat_attachment_remove, attachment.filename)
    val statusModifier =
        if (recoverable)
            Modifier.clickable(
                role = Role.Button,
                onClickLabel =
                    stringResource(
                        if (
                            attachment.failure == AttachmentFailure.UploadFailed &&
                                attachment.staged
                        )
                            R.string.retry
                        else R.string.chat_attachment_reselect,
                    ),
                onClick = recover,
            )
        else Modifier
    if (attachment.contentType.isAttachmentImage) {
        val focus = remember { FocusRequester() }
        val imageFocus =
            if (restoreFocus)
                Modifier.focusRequester(focus).onGloballyPositioned {
                    if (focus.requestFocus()) onFocusRestored()
                }
            else Modifier
        Box(card.width(132.dp).height(if (expanded) 104.dp else 80.dp)) {
            Box(
                Modifier.matchParentSize()
                    .padding(4.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(colors.surfaceVariant)
                    .then(imageFocus)
                    .clickable(onClick = open)
                    .semantics { contentDescription = attachment.filename },
                contentAlignment = Alignment.Center,
            ) {
                val reference = attachment.reference
                if (reference != null && remoteImages != null)
                    ChatAttachmentImage(
                        reference,
                        remoteImages,
                        threadId,
                        local,
                        Modifier.matchParentSize(),
                        describe = false,
                    )
                else if (local != null)
                    AsyncImage(
                        model = local,
                        contentDescription = null,
                        modifier = Modifier.matchParentSize(),
                        contentScale = ContentScale.Fit,
                    )
                else
                    Icon(painterResource(R.drawable.ic_image), null, tint = colors.onSurfaceVariant)
            }
            IconButton(
                onClick = remove,
                modifier = Modifier.align(Alignment.TopEnd).size(48.dp),
            ) {
                Box(
                    Modifier.size(24.dp).background(colors.surface, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(painterResource(R.drawable.ic_close), removeLabel, Modifier.size(16.dp))
                }
            }
            if (attachment.reference == null)
                Text(
                    text = status,
                    modifier =
                        Modifier.align(Alignment.BottomCenter)
                            .padding(4.dp)
                            .fillMaxWidth()
                            .background(colors.surface, RoundedCornerShape(4.dp))
                            .then(statusModifier)
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                    color = summaryColor,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            AttachmentProgress(percent, Modifier.align(Alignment.BottomCenter))
        }
    } else {
        Box(card.width(192.dp)) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    Modifier.weight(1f)
                        .heightIn(min = 48.dp)
                        .clickable(role = Role.Button, onClick = if (recoverable) recover else open)
                        .padding(start = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        painterResource(attachmentIcon(attachment.contentType)),
                        null,
                        Modifier.size(20.dp),
                        tint = colors.onSurfaceVariant,
                    )
                    Column(Modifier.weight(1f)) {
                        Text(
                            attachment.filename,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            status,
                            color = summaryColor,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                IconButton(onClick = remove, modifier = Modifier.size(48.dp)) {
                    Icon(painterResource(R.drawable.ic_close), removeLabel, Modifier.size(20.dp))
                }
            }
            AttachmentProgress(percent, Modifier.align(Alignment.BottomCenter))
        }
    }
}

@Composable
private fun AttachmentProgress(percent: Int?, modifier: Modifier) {
    if (percent != null)
        LinearProgressIndicator(
            progress = { percent / 100f },
            modifier = modifier.fillMaxWidth().padding(horizontal = 8.dp).height(2.dp),
            color = MaterialTheme.colorScheme.primary,
            trackColor = MaterialTheme.colorScheme.secondaryContainer,
            gapSize = 0.dp,
            drawStopIndicator = {},
        )
}

@Composable
internal fun attachmentSummary(type: String, size: Long?): String {
    val label =
        stringResource(
            when {
                type.isAttachmentVideo -> R.string.chat_attachment_type_video
                type.isAttachmentImage -> R.string.chat_attachment_type_image
                type.startsWith("text/", ignoreCase = true) -> R.string.chat_attachment_type_text
                else -> R.string.chat_attachment_type_file
            },
        )
    return if (size == null) label
    else
        stringResource(
            R.string.chat_attachment_type_size,
            label,
            Formatter.formatShortFileSize(LocalContext.current, size),
        )
}

internal fun attachmentIcon(type: String) =
    when {
        type.isAttachmentVideo -> R.drawable.ic_videocam
        type.isAttachmentImage -> R.drawable.ic_image
        else -> R.drawable.ic_folder
    }

@Composable
private fun DraftAttachmentPreview(
    attachment: DraftChatAttachment,
    file: File,
    cached: Boolean,
    close: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var unavailable by remember(cached) { mutableStateOf(!cached) }
    val text by
        produceState<String?>(null, file, cached) {
            if (
                cached &&
                    (attachment.contentType.startsWith("text/", ignoreCase = true) ||
                        attachment.contentType == "application/json")
            )
                value =
                    withContext(Dispatchers.IO) {
                        try {
                            file
                                .takeIf { it.isFile && it.length() <= 256 * 1024 }
                                ?.readText()
                                ?.removePrefix("\uFEFF")
                        } catch (_: IOException) {
                            null
                        }
                    }
        }
    val save =
        rememberLauncherForActivityResult(CreateDocument(attachment.contentType)) { uri ->
            if (uri != null)
                scope.launch {
                    unavailable =
                        withContext(Dispatchers.IO) {
                            try {
                                file.inputStream().use { source ->
                                    context.contentResolver.openOutputStream(uri, "wt")?.use {
                                        output ->
                                        source.copyTo(output)
                                    } ?: throw IOException("No writable attachment destination")
                                }
                                false
                            } catch (_: IOException) {
                                true
                            } catch (_: SecurityException) {
                                true
                            }
                        }
                }
        }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(attachment.filename) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (attachment.contentType.isAttachmentImage && !unavailable)
                    AsyncImage(
                        model = file,
                        contentDescription = attachment.filename,
                        modifier = Modifier.fillMaxWidth().aspectRatio(4f / 3f),
                        contentScale = ContentScale.Fit,
                        onError = { unavailable = true },
                    )
                Text(attachmentSummary(attachment.contentType, attachment.size))
                text?.let {
                    Text(
                        it,
                        Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (attachment.failure == AttachmentFailure.TooLarge)
                    Text(stringResource(R.string.chat_attachment_too_large))
                else if (unavailable)
                    Text(stringResource(R.string.chat_attachment_preview_unavailable))
            }
        },
        confirmButton = {
            TextButton(onClick = close) { Text(stringResource(R.string.updates_close)) }
        },
        dismissButton = {
            if (cached)
                Row {
                    TextButton(onClick = { save.launch(attachment.filename) }) {
                        Text(stringResource(R.string.chat_attachment_save))
                    }
                    if (!attachment.contentType.isAttachmentImage)
                        TextButton(
                            onClick = {
                                val uri =
                                    FileProvider.getUriForFile(
                                        context,
                                        "${context.packageName}.chat-attachments",
                                        file,
                                        attachment.filename,
                                    )
                                try {
                                    context.startActivity(
                                        Intent(Intent.ACTION_VIEW)
                                            .setDataAndType(uri, attachment.contentType)
                                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                                    )
                                } catch (_: ActivityNotFoundException) {
                                    unavailable = true
                                }
                            },
                        ) {
                            Text(stringResource(R.string.chat_attachment_open))
                        }
                }
        },
    )
}
