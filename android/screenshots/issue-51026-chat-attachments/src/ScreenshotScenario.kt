package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.historyEventWire
import ai.okou.android.testAuthenticationState
import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun sendsAndReadsAttachmentsFromTheNativeChat() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChat = app.chatService
        val oldComposer = app.composerService
        val oldControl = app.controlService
        val oldRecovery = app.recoveryService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val oldSize = displayOverride("size")
        val oldDensity = displayOverride("density")
        val text = "Confirm the overview and the follow-up owners.\n".toByteArray()
        val photo = sampleImage()
        val filenames = mapOf("checklist.txt" to text, "release-cover.png" to photo)
        val placed = mutableListOf<Uri>()
        val release = CountDownLatch(1)
        ComposerApiFixture(simulateHistory = false).use { fixture ->
            val attempts = AtomicInteger()
            val previewReads = AtomicInteger()
            val sentBytes = ConcurrentHashMap<String, ByteArray>()
            val fileById = ConcurrentHashMap<String, JsonObject>()
            val previous = fixture.chats.commandResponse
            val earlier = listOf(
                historyEventWire(
                    id = "a6f6e5a6-2ee7-4463-a3fb-161d6e7389b1",
                    seq = 17,
                    type = "input.prompt",
                    payload = """{"userMessage":{"version":1,"parts":[{"type":"text","text":"What is left before we can publish?"}]}}""",
                ),
                historyEventWire(
                    id = "c2b3ca9f-747b-4191-b24a-5d8721aad70f",
                    seq = 23,
                    payload = """{"content":"The release materials are ready for review. Check the cover and the final checklist before publishing."}""",
                ),
                historyEventWire(id = HISTORY_LAST_EVENT, type = "run.completed", payload = "null"),
            )
            fixture.chats.setHistoryEvents(CHAT_PERSONAL, earlier)
            fixture.chats.commandResponse = { request ->
                val url = checkNotNull(request.requestUrl)
                val path = url.encodedPath
                fun body() = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                fun info(id: String) = fileById.getValue(id)
                fun attachmentUrl(id: String) = fixture.chats.server.url("/fixture-download/$id").toString()
                when {
                    path == "/api/uploads/prepare" -> {
                        val selected = body()
                        val name = selected.getValue("filename").jsonPrimitive.content
                        if (name == "checklist.txt" && attempts.incrementAndGet() <= 3) {
                            json("""{"error":{"message":"Try again","code":"UNAVAILABLE"}}""")
                                .setResponseCode(503).setHeader("Retry-After", "0")
                        } else {
                            val id = UUID.randomUUID().toString()
                            check(selected.getValue("size").jsonPrimitive.content.toLong() ==
                                filenames.getValue(name).size.toLong())
                            val metadata = JsonObject(selected + mapOf(
                                "id" to JsonPrimitive(id),
                                "url" to JsonPrimitive("/artifacts/${id.replace("-", "")}.bin"),
                            ))
                            fileById[id] = metadata
                            json(JsonObject(metadata + mapOf(
                                "uploadUrl" to JsonPrimitive(fixture.chats.server.url("/fixture-upload/$id").toString()),
                                "uploadHeaders" to JsonObject(emptyMap()),
                            )).toString())
                        }
                    }
                    path.startsWith("/fixture-upload/") -> {
                        check(request.method == "PUT")
                        check(request.getHeader("Authorization") == null)
                        val id = path.substringAfterLast('/')
                        val name = info(id).getValue("filename").jsonPrimitive.content
                        val bytes = request.body.clone().readByteArray()
                        check(bytes.contentEquals(filenames.getValue(name)))
                        sentBytes[id] = bytes
                        MockResponse().setResponseCode(200)
                    }
                    path == "/api/uploads/complete" -> {
                        val id = body().getValue("id").jsonPrimitive.content
                        check(sentBytes.containsKey(id))
                        json(info(id).toString())
                    }
                    path == "/api/web/file-url" -> {
                        val id = checkNotNull(url.queryParameter("file_id"))
                        val link = attachmentUrl(id)
                        json("""{"url":"$link","downloadUrl":"$link","expiresAt":"2030-01-01T00:00:00Z","publicUrl":null}""")
                    }
                    path.startsWith("/fixture-download/") -> {
                        previewReads.incrementAndGet()
                        check(request.getHeader("Authorization") == null)
                        val id = path.substringAfterLast('/')
                        MockResponse()
                            .setHeader("Content-Type", info(id).getValue("contentType").jsonPrimitive.content)
                            .setBody(Buffer().write(sentBytes.getValue(id)))
                    }
                    else -> previous(request)
                }
            }
            fixture.beforeSendReturn = {
                check(release.await(40, TimeUnit.SECONDS))
                val input = fixture.inputs.values.single()
                val eventId = input.getValue("clientEventId").jsonPrimitive.content
                fixture.chats.setHistoryEvents(
                    CHAT_PERSONAL,
                    earlier + historyEventWire(
                        id = eventId,
                        seq = 40,
                        run = eventId,
                        type = "input.prompt",
                        payload = """{"userMessage":${input.getValue("userMessage")}}""",
                    ),
                )
            }
            fixture.inputDisposition = "consumed"
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.controlService = fixture.service
            app.recoveryService = fixture.service
            auth.state.value = testAuthenticationState(user = "attachment-native-${UUID.randomUUID()}")
            try {
                placed += placeFile("release-cover.png", "image/png", photo)
                placed += placeFile("checklist.txt", "text/plain", text)
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    action(By.text("Personal chat").pkg(app.packageName)).click()
                    options()
                    val pictures = action(By.text(app.getString(R.string.chat_attachment_photos)).pkg(app.packageName))
                    val documents = action(By.text(app.getString(R.string.chat_attachment_files)).pkg(app.packageName))
                    check(pictures.visibleBounds.height() == 56)
                    check(documents.visibleBounds.height() == 56)
                    ScreenshotCapture.capture("attachment-options.png")
                    pictures.click()
                    await("the system photo picker opens") {
                        device.currentPackageName?.startsWith("com.android.providers.media") == true ||
                            device.currentPackageName?.startsWith("com.google.android.providers.media") == true
                    }
                    device.pressBack()
                    await("the picker returns to the composer") {
                        device.hasObject(By.desc(app.getString(R.string.chat_options_title)).pkg(app.packageName))
                    }
                    options()
                    action(By.text(app.getString(R.string.chat_attachment_files)).pkg(app.packageName)).click()
                    chooseFile("release-cover.png")
                    await("uploaded image is ready") {
                        device.hasObject(By.desc("release-cover.png").pkg(app.packageName)) &&
                            findSend()?.isEnabled == true
                    }
                    options()
                    action(By.text(app.getString(R.string.chat_attachment_files)).pkg(app.packageName)).click()
                    chooseFile("checklist.txt")
                    val failure = By.text(app.getString(R.string.chat_attachment_failed)).pkg(app.packageName)
                    await("the failed file stays with the ready image") {
                        attempts.get() == 3 &&
                            device.hasObject(failure) &&
                            device.hasObject(By.desc("release-cover.png").pkg(app.packageName)) &&
                            findSend()?.isEnabled == false
                    }
                    ScreenshotCapture.capture("attachment-upload-failed.png")
                    action(failure).click()
                    await("the file retries without replacing the uploaded image") {
                        attempts.get() == 4 && findSend()?.isEnabled == true && !device.hasObject(failure)
                    }
                    val editor = item(By.clazz("android.widget.EditText").pkg(app.packageName))
                    val prompt = "Please review these release files."
                    editor.text = prompt
                    await("text and both attachments are in the draft") {
                        device.hasObject(By.text(prompt).pkg(app.packageName)) &&
                            device.hasObject(By.text("checklist.txt").pkg(app.packageName))
                    }
                    val sendBounds = checkNotNull(findSend()).visibleBounds
                    check(sendBounds.height() == 48 && sendBounds.width() == 48) { "Send target $sendBounds" }
                    ScreenshotCapture.capture("attachment-draft.png")
                    action(By.desc(app.getString(R.string.composer_send)).pkg(app.packageName)).click()
                    await("the pending user bubble owns both files") {
                        fixture.inputs.size == 1 &&
                            device.hasObject(By.text(prompt).pkg(app.packageName)) &&
                            device.hasObject(By.text("checklist.txt").pkg(app.packageName)) &&
                            device.hasObject(By.desc("release-cover.png").pkg(app.packageName))
                    }
                    val input = fixture.inputs.values.single()
                    check(input["hasTextContent"] == JsonPrimitive(true))
                    val parts = input.getValue("userMessage").jsonObject.getValue("parts").jsonArray
                    check(parts.map { it.jsonObject.getValue("type").jsonPrimitive.content } ==
                        listOf("text", "file", "file"))
                    check(parts.drop(1).map { it.jsonObject.getValue("filenameSnapshot").jsonPrimitive.content } ==
                        listOf("release-cover.png", "checklist.txt"))
                    ScreenshotCapture.capture("attachment-sending.png")
                    release.countDown()
                    await("the sent message resolves its authorized image") {
                        previewReads.get() > 0 &&
                            device.hasObject(By.text(prompt).pkg(app.packageName)) &&
                            device.hasObject(By.text("checklist.txt").pkg(app.packageName)) &&
                            coverIsDrawn() &&
                            !device.hasObject(By.desc(app.getString(R.string.composer_sending)).pkg(app.packageName))
                    }
                    ScreenshotCapture.capture("attachment-sent.png")
                }
            } finally {
                release.countDown()
                placed.forEach { app.contentResolver.delete(it, null, null) }
                auth.state.value = oldAuth
                app.chatService = oldChat
                app.composerService = oldComposer
                app.controlService = oldControl
                app.recoveryService = oldRecovery
                cache.restore()
                device.executeShellCommand("wm size $oldSize")
                device.executeShellCommand("wm density $oldDensity")
            }
        }
    }

    private fun placeFile(name: String, type: String, bytes: ByteArray): Uri {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, type)
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/")
        }
        val uri = checkNotNull(app.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
        checkNotNull(app.contentResolver.openOutputStream(uri)).use { it.write(bytes) }
        return uri
    }

    private fun sampleImage(): ByteArray {
        val bitmap = Bitmap.createBitmap(420, 420, Bitmap.Config.ARGB_8888)
        val drawable = checkNotNull(app.getDrawable(R.drawable.okou_mark))
        drawable.setBounds(0, 0, bitmap.width, bitmap.height)
        drawable.draw(Canvas(bitmap))
        return ByteArrayOutputStream().use {
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
            bitmap.recycle()
            it.toByteArray()
        }
    }

    private fun coverIsDrawn(): Boolean {
        val bounds = device.findObject(By.desc("release-cover.png").pkg(app.packageName))
            ?.visibleBounds ?: return false
        val screen = instrumentation.uiAutomation.takeScreenshot() ?: return false
        return try {
            (bounds.top until bounds.bottom step 4).any { y ->
                (bounds.left until bounds.right step 4).any { x ->
                    x in 0 until screen.width && y in 0 until screen.height &&
                        screen.getPixel(x, y) == 0xffffa500.toInt()
                }
            }
        } finally {
            screen.recycle()
        }
    }

    private fun options() {
        action(By.desc(app.getString(R.string.chat_options_title)).pkg(app.packageName)).click()
    }

    private fun chooseFile(filename: String) {
        val match = By.text(filename)
        if (device.wait(Until.findObject(match), 1_500) == null) {
            val roots = device.wait(Until.findObject(By.desc("Show roots")), 4_000)
            roots?.click()
            device.findObject(By.text("Downloads"))?.let { clickable(it)?.click() }
        }
        action(match).click()
        if (device.hasObject(match)) device.findObject(By.text("Open"))?.let { clickable(it)?.click() }
        await("Android returned the selected document") {
            device.hasObject(By.desc(app.getString(R.string.chat_options_title)).pkg(app.packageName))
        }
    }

    private fun findSend() = device.findObject(
        By.desc(app.getString(R.string.composer_send)).pkg(app.packageName),
    )

    private fun item(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }

    private fun clickable(node: UiObject2): UiObject2? =
        generateSequence(node) { it.parent }.firstOrNull { it.isClickable }

    private fun action(selector: BySelector): UiObject2 =
        checkNotNull(clickable(item(selector))) { "No clickable item for $selector" }

    private fun await(label: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 15_000L
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition()) return
            SystemClock.sleep(100)
        }
        error("Timed out waiting for $label")
    }

    private fun displayOverride(kind: String) =
        device.executeShellCommand("wm $kind").lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(": ")?.trim() ?: "reset"

    private fun json(body: String) =
        MockResponse().setHeader("Content-Type", "application/json").setBody(body)
}
