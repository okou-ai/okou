package ai.okou.android

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull

internal class InlineImageFixture(private val api: ChatListApiFixture) {
    val readyAlt = "Release readiness chart"
    val earlierAlt = "Staging baseline chart"
    val deniedAlt = "Restricted source image"
    @Volatile var filename = "release-readiness.png"
    val readyReference = "image00001.png"
    val earlierReference = "older00001.png"
    val deniedReference = "hidden0001.png"
    val references = CopyOnWriteArrayList<String>()
    val thumbnails = CopyOnWriteArrayList<String>()
    val originals = CopyOnWriteArrayList<String>()
    val previewUrls = CopyOnWriteArrayList<String>()
    private val signatures = AtomicInteger()
    var rotatePreviewUrls = false
    var missingThumbnail = false
    @Volatile var readyReferenceDenied = false
    @Volatile var readyFileId = "10000000-1000-4000-8000-000000000007"
    @Volatile var beforeReadyReference: () -> Unit = {}
    @Volatile var deniedExternalFilename: String? = null

    fun install(
        latest: String? = null,
        earlier: Boolean = true,
        earlierText: String =
            "Here is the first measurement.\n\n![$earlierAlt](/artifacts/$earlierReference)",
    ) {
        val image = chart()
        val previous = api.commandResponse
        api.commandResponse = { request ->
            val path = checkNotNull(request.requestUrl).encodedPath
            val name = path.substringAfterLast('/')
            when {
                path.startsWith("/api/artifact-references/") &&
                    name in listOf(readyReference, earlierReference, deniedReference) -> {
                    assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
                    references.add(name)
                    if (name == readyReference) beforeReadyReference()
                    if (name == readyReference && readyReferenceDenied)
                        jsonResponse("""{"error":{"code":"FORBIDDEN","message":"Unavailable"}}""")
                            .setResponseCode(403)
                    else if (name == deniedReference)
                        jsonResponse("""{"error":{"code":"NOT_FOUND","message":"Unavailable"}}""")
                            .setResponseCode(404)
                    else {
                        val file = if (name == readyReference) filename else "staging-baseline.png"
                        val signature =
                            if (rotatePreviewUrls) "?signature=${signatures.incrementAndGet()}"
                            else ""
                        val original = api.server.url("/inline-original/$name$signature")
                        val thumbnail = api.server.url("/inline-thumbnail/$name$signature")
                        if (name == readyReference) previewUrls.add(thumbnail.toString())
                        val poster =
                            if (missingThumbnail) "" else ""","previewImageUrl":"$thumbnail""""
                        jsonResponse(
                            """{"url":"$original","expiresAt":"2099-01-01T00:00:00.000Z","downloadUrl":"$original","filename":"$file","contentType":"image/png","downloadAllowed":false,"target":{"kind":"file","id":"$readyFileId"}$poster}""",
                        )
                    }
                }
                path.startsWith("/inline-thumbnail/") || path.startsWith("/inline-original/") -> {
                    assertNull(request.getHeader("Authorization"))
                    assertNull(request.getHeader("Cookie"))
                    if (path.startsWith("/inline-thumbnail/")) thumbnails.add(name)
                    else originals.add(name)
                    if (name == deniedExternalFilename) MockResponse().setResponseCode(403)
                    else
                        MockResponse()
                            .setHeader("Content-Type", "image/png")
                            .setBody(Buffer().write(image))
                }
                else -> previous(request)
            }
        }
        fun event(seq: Long, type: String, payload: String) =
            historyEventWire(
                "50647000-0000-4000-8000-${seq.toString().padStart(12, '0')}",
                seq,
                type = type,
                payload = payload,
            )
        fun reply(seq: Long, text: String) =
            event(seq, "output.message", """{"content":${JsonPrimitive(text)}}""")
        api.setHistoryEvents(
            CHAT_PERSONAL,
            buildList {
                add(
                    event(
                        1,
                        "input.prompt",
                        """{"userMessage":{"version":1,"parts":[{"type":"text","text":"How is the rollout looking?"}]}}""",
                    ),
                )
                if (earlier) {
                    add(
                        reply(
                            2,
                            earlierText,
                        ),
                    )
                    add(reply(3, "I checked the rollout checklist."))
                }
                add(
                    reply(
                        4,
                        latest
                            ?: "The rollout passed its checks.\n\n![$readyAlt](<https://app.okou.ai/artifacts/$readyReference>)\n\nThe release is ready for review.",
                    ),
                )
                add(event(5, "run.completed", "null"))
            },
        )
    }

    private fun chart(): ByteArray {
        val image = Bitmap.createBitmap(480, 432, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(image)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        fun color(value: String) {
            paint.color = Color.parseColor(value)
        }
        fun text(value: String, x: Float, y: Float, size: Float, bold: Boolean = false) {
            paint.textSize = size
            paint.typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            canvas.drawText(value, x, y, paint)
        }
        canvas.drawColor(Color.parseColor("#F9F4EF"))
        color("#322522")
        text("Rollout checks", 32f, 53f, 32f, bold = true)
        color("#685C56")
        text("Release readiness", 32f, 89f, 21f)
        val labels = listOf("Build", "Tests", "Assets", "Approval")
        val lengths = listOf(315f, 291f, 330f, 269f)
        for (index in labels.indices) {
            val y = 151f + index * 64
            color("#322522")
            text(labels[index], 32f, y - 9, 18f, bold = true)
            color("#EBDDD2")
            canvas.drawRoundRect(32f, y, 448f, y + 15, 7f, 7f, paint)
            color("#8D4A35")
            canvas.drawRoundRect(32f, y, 32 + lengths[index], y + 15, 7f, 7f, paint)
        }
        color("#685C56")
        text("RELEASE REVIEW", 32f, 396f, 16f, bold = true)
        return ByteArrayOutputStream()
            .also {
                image.compress(Bitmap.CompressFormat.PNG, 100, it)
                image.recycle()
            }
            .toByteArray()
    }
}
