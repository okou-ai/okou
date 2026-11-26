package ai.okou.android.chat

import ai.okou.android.api.MaxChatAttachmentBytes
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant9
import ai.okou.android.api.generated.SendRequestVariant1UserMessagePartsItemVariant9Type
import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

internal const val AttachmentOnlyPrompt = "(see attached files)"

@Serializable
data class ChatAttachmentReference(
    val id: String,
    val filename: String,
    val contentType: String,
    val size: Long? = null,
    val url: String? = null,
) {
    internal fun part() =
        SendRequestVariant1UserMessagePartsItemVariant9(
            SendRequestVariant1UserMessagePartsItemVariant9Type.FILE,
            id,
            filename,
            contentType,
        )
}

@Serializable
data class DraftChatAttachment(
    val key: String,
    val filename: String,
    val contentType: String,
    val size: Long? = null,
    val staged: Boolean = false,
    val reference: ChatAttachmentReference? = null,
    val failure: AttachmentFailure? = null,
)

internal fun ChatAttachmentReference.restoredAttachment() =
    DraftChatAttachment(UUID.randomUUID().toString(), filename, contentType, size, reference = this)

@Serializable
enum class AttachmentFailure {
    TooLarge,
    SourceUnavailable,
    UploadFailed,
}

interface ChatAttachmentService {
    suspend fun uploadChatAttachment(
        file: File,
        attachment: DraftChatAttachment,
        progress: (Long) -> Unit,
    ): ChatAttachmentReference

    suspend fun saveAttachmentDraft(
        target: ServerDraftTarget,
        text: String,
        attachments: List<ChatAttachmentReference>,
    )
}

internal val String.isAttachmentImage: Boolean
    get() = startsWith("image/", ignoreCase = true)

internal val String.isAttachmentVideo: Boolean
    get() = startsWith("video/", ignoreCase = true)

internal class AttachmentSourceUnavailable(cause: Exception? = null) :
    IOException("The selected attachment is no longer readable", cause)

internal class AttachmentTooLarge : IOException("The selected attachment exceeds 512 MiB")

internal fun ContentResolver.attachmentMetadata(uri: Uri): DraftChatAttachment {
    var filename = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
    var size: Long? = null
    var type: String? = null
    var failure: AttachmentFailure? = null
    try {
        type = getType(uri)
        query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val name = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val bytes = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (name >= 0) filename = cursor.getString(name)
                    if (bytes >= 0 && !cursor.isNull(bytes))
                        size = cursor.getLong(bytes).takeIf { it >= 0 }
                }
            }
    } catch (_: SecurityException) {
        failure = AttachmentFailure.SourceUnavailable
    } catch (_: IllegalArgumentException) {
        failure = AttachmentFailure.SourceUnavailable
    }
    return DraftChatAttachment(
        UUID.randomUUID().toString(),
        filename?.takeIf { it.isNotBlank() }?.take(255) ?: "attachment",
        type?.takeIf { it.isNotBlank() && it.length <= 200 } ?: "application/octet-stream",
        size,
        failure = if ((size ?: 0) > MaxChatAttachmentBytes) AttachmentFailure.TooLarge else failure,
    )
}

/** The file becomes recoverable only after the entire bounded copy is committed. */
internal suspend fun ContentResolver.stageChatAttachment(uri: Uri, file: File): Long =
    withContext(Dispatchers.IO) {
        val directory = checkNotNull(file.parentFile)
        val copying = directory.resolve("${file.name}.copy")
        if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory)
            throw IOException("Cannot create attachment cache")
        try {
            val source =
                try {
                    openInputStream(uri) ?: throw AttachmentSourceUnavailable()
                } catch (error: FileNotFoundException) {
                    throw AttachmentSourceUnavailable(error)
                } catch (error: SecurityException) {
                    throw AttachmentSourceUnavailable(error)
                }
            val size = source.use { input ->
                copying.outputStream().buffered().use { output ->
                    var written = 0L
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val read =
                            try {
                                input.read(buffer)
                            } catch (error: IOException) {
                                throw AttachmentSourceUnavailable(error)
                            }
                        if (read < 0) break
                        written += read
                        if (written > MaxChatAttachmentBytes) throw AttachmentTooLarge()
                        output.write(buffer, 0, read)
                    }
                    written
                }
            }
            currentCoroutineContext().ensureActive()
            if (!copying.renameTo(file)) throw IOException("Cannot commit attachment staging")
            size
        } finally {
            copying.delete()
        }
    }
