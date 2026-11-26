package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.chatEventWire
import ai.okou.android.rowEventTail
import ai.okou.android.testAuthenticationState
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
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
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun showsTheConversationModelAndMessageFeedback() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChat = app.chatService
        val oldComposer = app.composerService
        val oldControl = app.controlService
        val oldRecovery = app.recoveryService
        val oldConnectors = app.connectorService
        val apiPreferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val size = displayOverride("size")
        val density = displayOverride("density")
        val font = device.executeShellCommand("settings get system font_scale").trim()
        ComposerApiFixture().use { fixture ->
            ConnectorApiFixture().use { connectors ->
                val defaults = DefaultModelApiFixture(fixture.chats)
                val events = fixture.chats.rowEventTail()
                events += 102L to event(
                    102, "model_selection_updated",
                    mapOf(
                        "selectedModel" to JsonPrimitive("gpt-test"),
                        "modelSettingsPatch" to Json.parseToJsonElement("""{"model":"gpt-test","effort":"high"}"""),
                    ),
                )
                events += 103L to event(103, "service_tier_updated", mapOf("serviceTier" to JsonPrimitive("priority")))
                val modelRelease = CountDownLatch(1)
                val sendRelease = CountDownLatch(1)
                val modelStarted = CountDownLatch(1)
                val sendRequests = ConcurrentLinkedQueue<JsonObject>()
                val previous = fixture.chats.commandResponse
                fixture.chats.commandResponse = { request ->
                    val path = request.requestUrl?.encodedPath
                    when {
                        path == "/api/chat-threads/$CHAT_PERSONAL/model-selection" -> {
                            modelStarted.countDown()
                            modelRelease.await()
                            rejected(400)
                        }
                        path == "/api/chat/events" && request.method == "POST" -> {
                            sendRequests += Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                            if (sendRequests.size == 1) rejected(503)
                            else {
                                sendRelease.await()
                                rejected(400)
                            }
                        }
                        else -> previous(request)
                    }
                }
                app.chatService = fixture.service
                app.composerService = fixture.service
                app.controlService = fixture.service
                app.recoveryService = fixture.service
                app.connectorService = connectors.service
                auth.state.value = testAuthenticationState(user = "conversation-model-${UUID.randomUUID()}")
                try {
                    device.executeShellCommand("wm size 412x892")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale 1.0")
                    ActivityScenario.launch(MainActivity::class.java).use {
                        device.awaitChatList(app)
                        action(By.text("Personal chat")).click()
                        val title = app.getString(R.string.chat_options_title)
                        val model = By.text(app.getString(R.string.chat_options_model))
                        val gpt = By.text("GPT 5.6 Sol")
                        action(By.desc(title)).click()
                        await("confirmed model on the options row") {
                            findAction(model) != null && device.hasObject(gpt)
                        }
                        val row = action(model)
                        check(row.visibleBounds.height() == 72) { "Model entry: ${row.visibleBounds}" }
                        ScreenshotCapture.capture("conversation-model-entry.png")
                        row.click()
                        val auto = By.text(app.getString(R.string.settings_auto_model))
                        await("model picker replaces the options sheet") {
                            device.hasObject(auto) && !device.hasObject(By.text(title))
                        }
                        check(action(auto).visibleBounds.height() == 72)
                        val claude = action(By.text("Claude Sonnet 5"))
                        check(claude.visibleBounds.height() == 56)
                        val effort = action(By.text(app.getString(R.string.settings_model_effort_high)))
                        check(effort.visibleBounds.height() == 56)
                        val fast = action(By.text(app.getString(R.string.settings_model_fast)))
                        check(fast.isChecked && fast.visibleBounds.height() >= 72)
                        ScreenshotCapture.capture("conversation-model-picker.png")
                        val back = By.desc(app.getString(R.string.back)).pkg(app.packageName)
                        await("48dp app Back control in the model picker") {
                            pickerBack(back)?.visibleBounds?.let { it.height() == 48 && it.width() == 48 } == true
                        }
                        captureFastPress(fast)

                        claude.click()
                        val saving = By.text(app.getString(R.string.settings_saving))
                        val fastLabel = By.text(app.getString(R.string.settings_model_fast))
                        await("optimistic model while POST is held") {
                            modelStarted.count == 0L &&
                                device.hasObject(saving) &&
                                device.hasObject(By.text(app.getString(R.string.settings_model_effort_medium))) &&
                                !device.hasObject(fastLabel)
                        }
                        ScreenshotCapture.capture("conversation-model-saving.png")
                        modelRelease.countDown()
                        await("picker rolls back after rejection") {
                            device.hasObject(By.text(app.getString(R.string.chat_model_save_rejected))) &&
                                findAction(fastLabel)?.isChecked == true
                        }
                        ScreenshotCapture.capture("conversation-model-rejected.png")
                        checkNotNull(pickerBack(back)).click()
                        await("return to chat options") { device.hasObject(By.text(title)) && findAction(model) != null }
                        check(device.pressBack())
                        await("return to the editor") { !device.hasObject(model) }

                        val prompt = "Can you check the next steps?"
                        item(By.clazz("android.widget.EditText").pkg(app.packageName)).text = prompt
                        action(By.desc(app.getString(R.string.composer_send))).click()
                        await("the original input is retried") {
                            sendRequests.size == 2 && device.hasObject(By.text(prompt))
                        }
                        check(sendRequests.first() == sendRequests.last())
                        check(sendRequests.first().keys.none { it in setOf("inputModel", "model", "runOptions") })
                        check(defaults.writes.isEmpty())
                        assertNoGenericSendFailure()
                        ScreenshotCapture.capture("send-retrying.png")
                        sendRelease.countDown()
                        await("explicit rejection on the original message") {
                            device.hasObject(By.text(prompt)) &&
                                device.hasObject(By.text(app.getString(R.string.history_rejected)))
                        }
                        assertNoGenericSendFailure()
                        ScreenshotCapture.capture("send-rejected.png")
                    }
                } finally {
                    modelRelease.countDown()
                    sendRelease.countDown()
                    val cleanup = listOf(
                        runCatching {
                            auth.state.value = oldAuth
                            app.chatService = oldChat
                            app.composerService = oldComposer
                            app.controlService = oldControl
                            app.recoveryService = oldRecovery
                            app.connectorService = oldConnectors
                            app.restoreApiPreferences(apiPreferences)
                            cache.restore()
                        },
                        runCatching { device.executeShellCommand("wm size $size") },
                        runCatching { device.executeShellCommand("wm density $density") },
                        runCatching {
                            if (font.toFloatOrNull() == null) device.executeShellCommand("settings delete system font_scale")
                            else device.executeShellCommand("settings put system font_scale $font")
                        },
                    )
                    cleanup.forEach { it.getOrThrow() }
                }
            }
        }
    }

    private fun rejected(status: Int): MockResponse =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json")
            .setBody("""{"error":{"code":"BAD_REQUEST","message":"Fixture response"}}""")

    private fun assertNoGenericSendFailure() {
        check(!device.hasObject(By.text("The request failed. Your draft and pending message are retained.")))
    }

    private fun event(seq: Long, kind: String, fields: Map<String, kotlinx.serialization.json.JsonElement>): String =
        JsonObject(Json.parseToJsonElement(chatEventWire(id = UUID.randomUUID().toString(), seq = seq, kind = kind)).jsonObject + fields).toString()

    private fun displayOverride(kind: String): String =
        device.executeShellCommand("wm $kind").lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(": ")?.trim() ?: "reset"

    private fun captureFastPress(fast: UiObject2) {
        val bounds = fast.visibleBounds
        // The rest thumb is 24dp with a 4dp end gap. On press it grows to 28dp with a
        // 2dp gap. Sample a pixel between their left edges at the track's center line.
        val trackEnd = bounds.right - 16
        fun thumbHasExpanded(): Boolean {
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            return try {
                bitmap.getPixel(trackEnd - 29, bounds.centerY()) ==
                    bitmap.getPixel(trackEnd - 16, bounds.centerY())
            } finally {
                bitmap.recycle()
            }
        }
        check(!thumbHasExpanded()) { "Fast mode thumb already appears expanded" }
        val downTime = SystemClock.uptimeMillis()
        fun dispatch(action: Int) {
            val event = MotionEvent.obtain(
                downTime,
                SystemClock.uptimeMillis(),
                action,
                bounds.centerX().toFloat(),
                bounds.centerY().toFloat(),
                0,
            )
            try {
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                check(instrumentation.uiAutomation.injectInputEvent(event, true))
            } finally {
                event.recycle()
            }
        }
        dispatch(MotionEvent.ACTION_DOWN)
        try {
            await("28dp pressed Material 3 switch thumb") { thumbHasExpanded() }
            ScreenshotCapture.capture("conversation-model-fast-pressed.png")
        } finally {
            dispatch(MotionEvent.ACTION_CANCEL)
        }
        check(fast.isChecked)
    }

    private fun item(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "No node for $selector" }

    private fun clickable(item: UiObject2?): UiObject2? =
        generateSequence(item) { it.parent }.firstOrNull { it.isClickable }

    private fun pickerBack(selector: BySelector): UiObject2? =
        device.findObjects(selector).mapNotNull(::clickable).maxByOrNull { it.visibleBounds.top }

    private fun findAction(selector: BySelector): UiObject2? =
        device.findObjects(selector).firstNotNullOfOrNull { clickable(it)?.takeIf { row -> row.isEnabled } }

    private fun action(selector: BySelector): UiObject2 {
        var match: UiObject2? = null
        await("enabled action $selector") {
            match = findAction(selector)
            match != null
        }
        return checkNotNull(match)
    }

    private fun await(expected: String, predicate: () -> Boolean) {
        val ready = device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice) = try { predicate() } catch (_: StaleObjectException) { false }
        }, 12_000)
        if (!ready) {
            val hierarchy = ByteArrayOutputStream()
            device.dumpWindowHierarchy(hierarchy)
            ScreenshotCapture.capture("diagnostic-unexpected-state.png")
            error("Timed out waiting for $expected. ${hierarchy.toString(Charsets.UTF_8.name())}")
        }
    }
}
