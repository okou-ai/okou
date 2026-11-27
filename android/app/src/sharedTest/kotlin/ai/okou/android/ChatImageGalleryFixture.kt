package ai.okou.android

import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chat.ChatAttachmentReference
import ai.okou.android.chat.ComposerJournal
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.DraftChatAttachment
import ai.okou.android.chat.EditableComposerDraft
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import okhttp3.mockwebserver.MockResponse
import okio.Buffer

internal class ChatImageGalleryFixture(
    private val api: ChatListApiFixture,
    encodedSample: ByteArray? = null,
) {
    val prompt = "Two references for the launch."
    val draftText = "Which direction should we take?"
    val first = "Blue coast.png"
    val second = "Desert dusk.png"
    val originalReads = CopyOnWriteArrayList<String>()
    val thumbnailReads = CopyOnWriteArrayList<String>()
    val resolves = CopyOnWriteArrayList<String>()
    @Volatile var denied: String? = null
    @Volatile var downloadDenied: String? = null
    @Volatile var beforeOriginal: (String) -> Unit = {}
    private val images =
        listOf(
            Image(
                "51475000-0000-4000-8000-000000000001",
                first,
                encodedSample
                    ?: landscape(720, 480, Color.rgb(199, 224, 237), Color.rgb(31, 88, 135)),
            ),
            Image(
                "51475000-0000-4000-8000-000000000002",
                second,
                encodedSample
                    ?: landscape(520, 680, Color.rgb(255, 205, 166), Color.rgb(145, 63, 88)),
            ),
        )

    fun install(includeHistory: Boolean = true) {
        if (includeHistory) {
            val (one, two) = images
            api.setHistoryEvents(
                CHAT_PERSONAL,
                listOf(
                    historyEventWire(
                        id = "51475000-0000-4000-8000-000000000003",
                        seq = 1,
                        type = "input.prompt",
                        payload =
                            """
                            {"userMessage":{"version":1,"parts":[
                              {"type":"text","text":"$prompt"},
                              ${one.part()},
                              {"type":"file","fileId":"51475000-0000-4000-8000-000000000004","filenameSnapshot":"Notes.txt","contentType":"text/plain"},
                              ${two.part()}
                            ]}}
                        """
                                .trimIndent(),
                    ),
                    historyEventWire(
                        id = "51475000-0000-4000-8000-000000000005",
                        seq = 2,
                        type = "run.completed",
                        payload = "null",
                    ),
                ),
            )
        }
        val previous = api.commandResponse
        api.commandResponse = response@{ request ->
            val url = request.requestUrl ?: return@response previous(request)
            val path = url.encodedPath
            when {
                path == "/api/web/file-url" -> {
                    val image = images.firstOrNull { it.id == url.queryParameter("file_id") }
                    if (image != null) resolves += image.filename
                    when {
                        image == null -> previous(request)
                        image.filename == denied -> MockResponse().setResponseCode(404)
                        else -> {
                            val original = api.server.url("/chat-gallery/${image.id}/original")
                            val thumb = api.server.url("/chat-gallery/${image.id}/thumbnail")
                            val download = api.server.url("/chat-gallery/${image.id}/download")
                            jsonResponse(
                                """{"url":"$original","downloadUrl":"$download","previewImageUrl":"$thumb","expiresAt":"2099-01-01T00:00:00Z","publicUrl":null}""",
                            )
                        }
                    }
                }
                path.startsWith("/chat-gallery/") -> {
                    val segments = url.pathSegments
                    val image = images.single { it.id == segments[1] }
                    when (segments[2]) {
                        "original" -> {
                            originalReads += image.filename
                            beforeOriginal(image.filename)
                        }
                        "thumbnail" -> thumbnailReads += image.filename
                        "download" ->
                            if (image.filename == downloadDenied)
                                return@response MockResponse().setResponseCode(403)
                    }
                    MockResponse()
                        .addHeader("Content-Type", "image/png")
                        .setBody(Buffer().write(image.bytes))
                }
                else -> previous(request)
            }
        }
    }

    suspend fun seedDraft(
        store: ComposerJournalStore,
        identity: WorkspaceIdentity,
        target: String,
        uploaded: Boolean,
    ): List<String> {
        val directory = store.attachmentDirectory(identity)
        check(directory.mkdirs() || directory.isDirectory)
        val attachments = images.map { image ->
            val key = UUID.randomUUID().toString()
            directory.resolve(key).writeBytes(image.bytes)
            DraftChatAttachment(
                key,
                image.filename,
                "image/png",
                image.bytes.size.toLong(),
                staged = true,
                reference =
                    ChatAttachmentReference(image.id, image.filename, "image/png").takeIf {
                        uploaded
                    },
            )
        }
        store
            .persist(
                identity,
                ComposerJournal(
                    format = 4,
                    drafts =
                        mapOf(
                            target to
                                EditableComposerDraft(
                                    draftText,
                                    dirty = true,
                                    revision = 1,
                                    attachments = attachments,
                                ),
                        ),
                ),
            )
            .await()
        return attachments.map { it.key }
    }

    private data class Image(val id: String, val filename: String, val bytes: ByteArray) {
        fun part() =
            """{"type":"file","fileId":"$id","filenameSnapshot":"$filename","contentType":"image/png"}"""
    }

    private fun landscape(width: Int, height: Int, sky: Int, hills: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            val w = width.toFloat()
            val h = height.toFloat()
            val canvas = Canvas(bitmap)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            canvas.drawColor(sky)
            paint.color = Color.rgb(255, 241, 196)
            canvas.drawCircle(w * .71f, h * .29f, w * .10f, paint)
            paint.color = hills
            val land =
                Path().apply {
                    moveTo(0f, h * .53f)
                    cubicTo(w * .35f, h * .24f, w * .46f, h * .72f, w, h * .47f)
                    lineTo(w, h)
                    lineTo(0f, h)
                    close()
                }
            canvas.drawPath(land, paint)
            paint.color = sky
            paint.alpha = 108
            val band =
                Path().apply {
                    moveTo(0f, h * .71f)
                    cubicTo(w * .27f, h * .88f, w * .56f, h * .58f, w, h * .69f)
                    lineTo(w, h * .81f)
                    cubicTo(w * .55f, h * .76f, w * .36f, h * .97f, 0f, h * .84f)
                    close()
                }
            canvas.drawPath(band, paint)
            return ByteArrayOutputStream().use {
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                it.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }
    }
}
