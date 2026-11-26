package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.InlineImageFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.awaitChatList
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun keepsTheReplyImageOnScreenWakeAndAReopenedChat() = withApi { api, realtime ->
        val fixture = InlineImageFixture(api)
        fixture.rotatePreviewUrls = true
        fixture.install(
            latest = "The rollout passed its checks.\n\n![](/artifacts/${fixture.readyReference})\n\nThe release is ready for review.",
            earlier = false,
        )
        allowHttpCaching(api)
        val image = By.desc(fixture.filename)
        val chartPaper = Color.parseColor("#F9F4EF")
        val existing = thumbFiles()
        openChat {
            val before = painted(image, chartPaper)
            check(before.width() == 240 && before.height() == 216)
            check(fixture.thumbnails == listOf(fixture.readyReference))
            ScreenshotCapture.capture("chat-image-before-sleep.png")
            val checkStarted = CountDownLatch(1)
            val release = CountDownLatch(1)
            fixture.beforeReadyReference = {
                checkStarted.countDown()
                check(release.await(30, TimeUnit.SECONDS))
            }
            try {
                val closed = realtime.closed.get()
                device.sleep()
                await("screen off and realtime stopped") { !device.isScreenOn && realtime.closed.get() > closed }
                device.wakeUp()
                device.executeShellCommand("wm dismiss-keyguard")
                check(checkStarted.await(12, TimeUnit.SECONDS)) { "No permission check after wake" }
                check(painted(image, chartPaper) == before) { "Wake changed the image frame" }
                check(fixture.thumbnails == listOf(fixture.readyReference)) { "Wake downloaded the thumbnail again" }
                ScreenshotCapture.capture("chat-image-after-wake.png")
            } finally {
                fixture.beforeReadyReference = {}
                release.countDown()
                if (!device.isScreenOn) device.wakeUp()
            }
            device.pressBack()
            device.awaitChatList(app)
            item(By.text("Personal chat")).click()
            painted(image, chartPaper)
            check(fixture.thumbnails == listOf(fixture.readyReference)) { "Reopening the chat downloaded the thumbnail again" }
            await("thumbnail saved to disk") { (thumbFiles() - existing).isNotEmpty() }
        }
        val previousUrls = fixture.previewUrls.toSet()
        val freshName = "release-readiness-verified.png"
        val issued = CountDownLatch(1)
        val release = CountDownLatch(1)
        fixture.filename = freshName
        fixture.beforeReadyReference = {
            issued.countDown()
            check(release.await(30, TimeUnit.SECONDS))
        }
        openChat {
            try {
                check(issued.await(12, TimeUnit.SECONDS)) { "No permission check in the new Activity" }
                painted(image, chartPaper)
                check(fixture.thumbnails == listOf(fixture.readyReference))
                ScreenshotCapture.capture("chat-image-from-disk.png")
            } finally {
                fixture.beforeReadyReference = {}
                release.countDown()
            }
            painted(By.desc(freshName), chartPaper)
            check((fixture.previewUrls.toSet() - previousUrls).isNotEmpty())
            check(fixture.thumbnails == listOf(fixture.readyReference)) {
                "Changed delivery URL caused another download for the same file"
            }
            Log.i("ChatImageProbe", "Reply thumbnail transfers after first display, wake, chat reopen and new Activity: 1, 1, 1, 1")
            Log.i("ChatImageProbe", "Distinct issued reply URLs: ${fixture.previewUrls.toSet().size}")

            fixture.readyFileId = "10000000-1000-4000-8000-000000000008"
            fixture.filename = "release-readiness-replacement.png"
            realtime.invalidate()
            painted(By.desc(fixture.filename), chartPaper)
            check(fixture.thumbnails == listOf(fixture.readyReference, fixture.readyReference))
            Log.i("ChatImageProbe", "Transfers after the reference resolved to a different file: 2")

            await("replacement saved to disk") { (thumbFiles() - existing).isNotEmpty() }
            fixture.readyReferenceDenied = true
            realtime.invalidate()
            item(By.desc(app.getString(ai.okou.android.R.string.artifact_image)))
            await("revoked thumbnail evicted from disk") { (thumbFiles() - existing).isEmpty() }
            check(fixture.thumbnails.size == 2)
        }
    }

    @Test
    fun withdrawsOriginalAccessOnWakeWhenTheImageHasNoThumbnail() = withApi { api, realtime ->
        val fixture = InlineImageFixture(api)
        fixture.missingThumbnail = true
        fixture.install(
            latest = "The release chart is attached.\n\n![](/artifacts/${fixture.readyReference})\n\nThe release is ready for review.",
            earlier = false,
        )
        openChat {
            val image = app.getString(ai.okou.android.R.string.artifact_image)
            try {
                val original = By.desc(fixture.filename)
                val position = item(original).visibleBounds
                ScreenshotCapture.capture("chat-image-no-thumbnail.png")

                check(device.click(position.centerX(), position.centerY()))
                await("the original image opened from the placeholder") {
                    fixture.readyReference in fixture.originals
                }
                item(By.text(fixture.filename))
                device.pressBack()
                item(original)
                val previousChecks = fixture.references.size
                val previousDownloads = fixture.originals.toList()
                fixture.readyReferenceDenied = true
                val closed = realtime.closed.get()
                device.sleep()
                await("screen off and realtime stopped") { !device.isScreenOn && realtime.closed.get() > closed }
                device.wakeUp()
                device.executeShellCommand("wm dismiss-keyguard")
                await("the unavailable image state") {
                    fixture.references.size > previousChecks &&
                        !device.hasObject(original) &&
                        device.hasObject(By.desc(image))
                }
                check(fixture.thumbnails.isEmpty() && fixture.originals.toList() == previousDownloads)
                Log.i("ChatImageProbe", "Wake withdrew the original action and filename")
                ScreenshotCapture.capture("chat-image-access-revoked.png")
            } catch (failure: IllegalStateException) {
                ScreenshotCapture.capture("chat-image-withdrawal-diagnostic.png")
                throw failure
            } finally {
                if (!device.isScreenOn) device.wakeUp()
            }
        }
    }

    @Test
    fun showsASingleSentImageAboveItsFile() = withApi { api, _ ->
        val doc = Attachment("Launch checklist.txt", "text/plain")
        val photo = Attachment("Launch overview.png", "image/png", 480, 360, "#E9DCD1")
        val body = "Please review these launch materials."
        val existing = thumbFiles()
        val transfers = installAttachments(api, listOf(photo, doc), body)
        openChat {
            val image = painted(By.desc(photo.filename), photo.background)
            val file = item(By.textContains(doc.filename)).visibleBounds
            val text = item(By.text(body)).visibleBounds
            check(image.width() == 240 && image.height() == 180) { "Single image: $image" }
            check(text.bottom <= image.top && image.bottom < file.top)
            ScreenshotCapture.capture("sent-single-image.png")

            item(By.textContains(doc.filename)).click()
            item(By.textContains("Assign a launch owner and run the deployment checklist."))
            device.pressBack()
            check(painted(By.desc(photo.filename), photo.background) == image)
            check(transfers.media.count { it == photo.filename } == 1)
            await("sent attachment saved to disk") { (thumbFiles() - existing).isNotEmpty() }
        }
        val previousUrls = transfers.urls.toSet()
        openChat {
            painted(By.desc(photo.filename), photo.background)
            await("a new signed delivery URL") { (transfers.urls.toSet() - previousUrls).isNotEmpty() }
            check(transfers.media.count { it == photo.filename } == 1)
            Log.i("ChatImageProbe", "Sent attachment transfers for a retained owner and after Activity close: 1, 1")
        }
    }

    @Test
    fun placesImagesAndFilesInTheirOriginalOrderWithinEachGroup() = withApi { api, _ ->
        val first = Attachment("Launch channels.png", "image/png", 480, 270, "#E1E7F5")
        val second = Attachment("Email schedule.png", "image/png", 320, 480, "#F2E0EA")
        val third = Attachment("Landing page.png", "image/png", 480, 480, "#DCE9DA")
        val checklist = Attachment("Launch checklist.txt", "text/plain")
        val notes = Attachment("Review notes.txt", "text/plain")
        installAttachments(api, listOf(first, checklist, second, notes, third))
        openChat {
            val a = painted(By.desc(first.filename), first.background)
            val b = painted(By.desc(second.filename), second.background)
            val c = painted(By.desc(third.filename), third.background)
            val f = item(By.textContains(checklist.filename)).visibleBounds
            val g = item(By.textContains(notes.filename)).visibleBounds
            check(a.width() == 126 && a.height() in 94..95) { "Gallery tile: $a" }
            check(a.top == b.top && b.left - a.right == 8 && b.width() == a.width())
            check(c.left == a.left && c.top - a.bottom == 8 && c.width() == a.width())
            check(c.bottom < f.top && f.bottom < g.top)
            ScreenshotCapture.capture("sent-image-gallery.png")
        }
    }

    private class Attachment(
        val filename: String,
        val type: String,
        val width: Int = 0,
        val height: Int = 0,
        color: String = "#FFFFFF",
    ) {
        val id = UUID.randomUUID().toString()
        val background = Color.parseColor(color)

        fun content(): MockResponse =
            MockResponse().setHeader("Content-Type", type)
                .setHeader("Cache-Control", "private, max-age=3600")
                .apply {
                    if (type.startsWith("image/")) setBody(Buffer().write(image()))
                    else setBody("Assign a launch owner and run the deployment checklist.")
                }

        private fun image(): ByteArray {
            val image = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(image)
            canvas.drawColor(background)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val pad = width * .09f
            paint.color = Color.parseColor("#312923")
            paint.typeface = Typeface.DEFAULT_BOLD
            paint.textSize = width * .072f
            canvas.drawText(filename.substringBefore('.'), pad, height * .24f, paint)
            for ((index, fill) in listOf(.91f, .71f, .84f).withIndex()) {
                val top = height * (.40f + index * .13f)
                val bottom = top + height * .05f
                paint.color = Color.parseColor("#86766B")
                canvas.drawRoundRect(pad, top, width - pad, bottom, 6f, 6f, paint)
                paint.color = Color.parseColor("#473A32")
                canvas.drawRoundRect(pad, top, pad + (width - 2 * pad) * fill, bottom, 6f, 6f, paint)
            }
            return ByteArrayOutputStream().also {
                image.compress(Bitmap.CompressFormat.PNG, 100, it)
                image.recycle()
            }.toByteArray()
        }
    }

    private fun installAttachments(
        api: ChatListApiFixture,
        attachments: List<Attachment>,
        text: String? = null,
    ): AttachmentTransfers {
        val transfers = AttachmentTransfers()
        val signatures = AtomicInteger()
        val files = attachments.associateBy { it.id }
        val parts = buildList {
            if (text != null) add("""{"type":"text","text":${JsonPrimitive(text)}}""")
            for (file in attachments)
                add("""{"type":"file","fileId":"${file.id}","filenameSnapshot":${JsonPrimitive(file.filename)},"contentType":"${file.type}"}""")
        }
        api.setHistoryEvents(
            CHAT_PERSONAL,
            listOf(
                historyEventWire(
                    id = "95711520-0f31-43ea-a0a2-4fcffd71c109",
                    seq = 1,
                    type = "input.prompt",
                    payload = """{"userMessage":{"version":1,"parts":[${parts.joinToString(",")}]}}""",
                ),
                historyEventWire(id = HISTORY_LAST_EVENT, seq = 2, type = "run.completed", payload = "null"),
            ),
        )
        val previous = api.commandResponse
        api.commandResponse = { request ->
            val target = checkNotNull(request.requestUrl)
            val path = target.encodedPath
            when {
                path == "/api/web/file-url" -> {
                    check(request.getHeader("Authorization") == "Bearer fixture-token")
                    val id = checkNotNull(target.queryParameter("file_id"))
                    check(id in files)
                    val url = api.server.url("/sent-file/$id?signature=${signatures.incrementAndGet()}")
                    if (files.getValue(id).type.startsWith("image/")) transfers.urls += url.toString()
                    jsonResponse("""{"url":"$url","expiresAt":"2099-01-01T00:00:00.000Z","downloadUrl":"$url","publicUrl":null}""")
                }
                path.startsWith("/sent-file/") -> {
                    check(request.getHeader("Authorization") == null && request.getHeader("Cookie") == null)
                    val file = files.getValue(path.substringAfterLast('/'))
                    transfers.media += file.filename
                    file.content()
                }
                else -> previous(request)
            }
        }
        return transfers
    }

    private class AttachmentTransfers {
        val urls = CopyOnWriteArrayList<String>()
        val media = CopyOnWriteArrayList<String>()
    }

    private fun thumbFiles(): Set<File> =
        app.cacheDir.resolve("chat-thumbnails-v1").walkTopDown().filter { it.extension == "thumb" }.toSet()

    private fun allowHttpCaching(api: ChatListApiFixture) {
        val previous = api.commandResponse
        api.commandResponse = { request ->
            val response = previous(request)
            if (request.requestUrl?.encodedPath?.startsWith("/inline-thumbnail/") == true)
                response?.setHeader("Cache-Control", "private, max-age=3600")
            else response
        }
    }

    private fun openChat(test: () -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use {
            device.awaitChatList(app)
            item(By.text("Personal chat")).click()
            test()
        }
    }

    private fun withApi(test: (ChatListApiFixture, TestRealtimeService) -> Unit) {
        val size = displayOverride("size")
        val density = displayOverride("density")
        val auth = app.authentication as TestAuthentication
        val authState = auth.state.value
        val chats = app.chatService
        val composer = app.composerService
        val oldRealtime = app.realtimeService
        val realtime = TestRealtimeService()
        val prefs = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                app.chatService = api.service
                app.composerService = api.service
                app.realtimeService = realtime
                auth.state.value = testAuthenticationState(user = "chat-image-capture-${UUID.randomUUID()}")
                test(api, realtime)
            } finally {
                auth.state.value = authState
                app.chatService = chats
                app.composerService = composer
                app.realtimeService = oldRealtime
                app.restoreApiPreferences(prefs)
                cache.restore()
                device.executeShellCommand("wm size $size")
                device.executeShellCommand("wm density $density")
            }
        }
    }

    private fun displayOverride(kind: String) =
        device.executeShellCommand("wm $kind").lineSequence()
            .firstOrNull { it.startsWith("Override") }
            ?.substringAfter(": ")?.trim() ?: "reset"

    private fun item(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "No node for $selector" }

    private fun await(expected: String, condition: () -> Boolean) {
        check(device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean =
                try { condition() } catch (_: StaleObjectException) { false }
        }, 12_000)) { "Timed out waiting for $expected" }
    }

    private fun painted(selector: BySelector, color: Int): Rect {
        await("image pixels for $selector") {
            val bounds = device.findObject(selector)?.visibleBounds ?: return@await false
            if (bounds.width() < 40 || bounds.height() < 40) return@await false
            val screenshot = instrumentation.uiAutomation.takeScreenshot() ?: return@await false
            val sample = try { screenshot.getPixel(bounds.centerX(), bounds.centerY() - bounds.height() / 6) }
            finally { screenshot.recycle() }
            abs(Color.red(sample) - Color.red(color)) <= 3 &&
                abs(Color.green(sample) - Color.green(color)) <= 3 &&
                abs(Color.blue(sample) - Color.blue(color)) <= 3
        }
        return item(selector).visibleBounds
    }
}
