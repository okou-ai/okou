package ai.okou.android.api

import ai.okou.android.api.generated.AbortChatMultipartUploadRequest
import ai.okou.android.api.generated.CanonicalTrue
import ai.okou.android.api.generated.CompleteChatMultipartUploadRequest
import ai.okou.android.api.generated.CompleteChatUploadRequest
import ai.okou.android.api.generated.PrepareChatUploadRequest
import ai.okou.android.api.generated.PrepareChatUploadResultVariant1
import ai.okou.android.api.generated.PrepareChatUploadResultVariant2
import ai.okou.android.chat.ChatAttachmentReference
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.RequestBody
import okio.BufferedSink

internal const val MaxChatAttachmentBytes = 512L * 1024 * 1024
private const val MultipartThresholdBytes = 5L * 1024 * 1024

internal class AttachmentStorageRejection(val response: ApiFailure.Http) : IOException(response)

/** The caller owns the staged file and keeps it immutable until the upload finishes. */
internal suspend fun uploadChatAttachment(
    api: ApiClient,
    transfers: SignedTransferClient,
    file: File,
    name: String,
    contentType: String,
    size: Long,
    progress: (Long) -> Unit,
): ChatAttachmentReference {
    require(size in 0..MaxChatAttachmentBytes)
    val request =
        PrepareChatUploadRequest(
            filename = name,
            contentType = contentType,
            size = size,
            multipart = CanonicalTrue.takeIf { size >= MultipartThresholdBytes },
        )
    return when (val prepared = api.write { prepareChatUpload(it, request) }) {
        is PrepareChatUploadResultVariant1 -> {
            transfers.putAttachment(
                prepared.uploadUrl.toHttpUrlOrNull() ?: throw ApiFailure.IncompatibleResponse(),
                file.uploadBody(0, size, progress),
                mapOf("Content-Type" to prepared.contentType) + prepared.uploadHeaders,
            )
            val confirmed = api.write {
                completeChatUpload(it, CompleteChatUploadRequest(prepared.id, prepared.contentType))
            }
            if (confirmed.id != prepared.id || confirmed.size != size.toDouble())
                throw ApiFailure.IncompatibleResponse()
            ChatAttachmentReference(
                confirmed.id,
                confirmed.filename,
                confirmed.contentType,
                size,
                confirmed.url,
            )
        }
        is PrepareChatUploadResultVariant2 -> {
            val multipart = prepared.multipart
            var partsUploaded = false
            try {
                val parts = multipart.parts.sortedBy { it.partNumber }
                if (
                    multipart.partSize !in 1..MaxChatAttachmentBytes ||
                        size == 0L ||
                        parts.size.toLong() != 1 + (size - 1) / multipart.partSize ||
                        parts.withIndex().any { (index, part) -> part.partNumber != index + 1L }
                )
                    throw ApiFailure.IncompatibleResponse()
                for ((index, part) in parts.withIndex()) {
                    val offset = index * multipart.partSize
                    val length = minOf(multipart.partSize, size - offset)
                    transfers.putAttachment(
                        part.uploadUrl.toHttpUrlOrNull() ?: throw ApiFailure.IncompatibleResponse(),
                        file.uploadBody(offset, length) { progress(offset + it) },
                        mapOf("Content-Type" to prepared.contentType),
                    )
                }
                partsUploaded = true
                val confirmed = api.write {
                    completeChatMultipartUpload(
                        it,
                        CompleteChatMultipartUploadRequest(
                            prepared.id,
                            prepared.filename,
                            multipart.uploadId,
                            parts.size.toLong(),
                        ),
                    )
                }
                if (confirmed.id != prepared.id) throw ApiFailure.IncompatibleResponse()
                ChatAttachmentReference(
                    confirmed.id,
                    prepared.filename,
                    prepared.contentType,
                    size,
                    confirmed.url,
                )
            } finally {
                // Once completion is attempted the server may already own the confirmed object.
                if (!partsUploaded)
                    withContext(NonCancellable) {
                        withTimeoutOrNull(5.seconds) {
                            try {
                                api.write {
                                    abortChatMultipartUpload(
                                        it,
                                        AbortChatMultipartUploadRequest(
                                            prepared.id,
                                            prepared.filename,
                                            multipart.uploadId,
                                        ),
                                    )
                                }
                            } catch (_: ApiFailure) {
                                // Storage expires an incomplete multipart upload.
                            }
                        }
                    }
            }
        }
    }
}

private suspend fun SignedTransferClient.putAttachment(
    url: okhttp3.HttpUrl,
    body: RequestBody,
    headers: Map<String, String>,
) {
    try {
        upload(url, body, headers)
    } catch (error: ApiFailure.Http) {
        // Only a rejection from the canonical API can retire a workspace session.
        throw AttachmentStorageRejection(error)
    }
}

private suspend fun File.uploadBody(
    offset: Long,
    length: Long,
    progress: (Long) -> Unit,
): RequestBody {
    val context = currentCoroutineContext()
    return object : RequestBody() {
        override fun contentType() = null

        override fun contentLength() = length

        override fun writeTo(sink: BufferedSink) {
            RandomAccessFile(this@uploadBody, "r").use { input ->
                input.seek(offset)
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var written = 0L
                while (written < length) {
                    context.ensureActive()
                    val count =
                        input.read(buffer, 0, minOf(buffer.size.toLong(), length - written).toInt())
                    if (count < 0) throw EOFException("Chat attachment staging ended early")
                    sink.write(buffer, 0, count)
                    written += count
                    progress(written)
                }
            }
        }
    }
}
