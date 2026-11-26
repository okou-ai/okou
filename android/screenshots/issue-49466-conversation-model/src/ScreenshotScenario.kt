package ai.okou.android.screenshots

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
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun showsTheConfirmedConversationModelAndSharedPicker() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChat = app.chatService
        val oldComposer = app.composerService
        val oldRecovery = app.recoveryService
        val oldConnectors = app.connectorService
        val apiPreferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val size = displayOverride("size")
        val density = displayOverride("density")
        val font = device.executeShellCommand("settings get system font_scale").trim()
        ComposerApiFixture().use { fixture ->
            ConnectorApiFixture().use { connectors ->
                DefaultModelApiFixture(fixture.chats)
                val events = fixture.chats.rowEventTail()
                events += 102L to event(
                    102, "model_selection_updated",
                    mapOf(
                        "selectedModel" to JsonPrimitive("gpt-test"),
                        "modelSettingsPatch" to Json.parseToJsonElement("""{"model":"gpt-test","effort":"high"}"""),
                    ),
                )
                events += 103L to event(103, "service_tier_updated", mapOf("serviceTier" to JsonPrimitive("priority")))
                app.chatService = fixture.service
                app.composerService = fixture.service
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
                        action(By.desc(app.getString(R.string.chat_options_title))).click()
                        val row = action(By.text(app.getString(R.string.chat_options_model)))
                        check(row.visibleBounds.height() == 72)
                        item(By.text("GPT 5.6 Sol"))
                        ScreenshotCapture.capture("conversation-model-entry.png")
                        row.click()
                        check(action(By.text(app.getString(R.string.settings_auto_model))).visibleBounds.height() == 72)
                        check(action(By.text("GPT 5.6 Sol")).visibleBounds.height() == 56)
                        check(action(By.text("Claude Sonnet 5")).visibleBounds.height() == 56)
                        val effort = action(By.text(app.getString(R.string.settings_model_effort_high)))
                        check(effort.visibleBounds.height() == 56)
                        val fast = action(By.text(app.getString(R.string.settings_model_fast)))
                        check(fast.isChecked && fast.visibleBounds.height() >= 72)
                        val back = device.findObjects(By.desc(app.getString(R.string.back)))
                            .mapNotNull { clickable(it) }.maxByOrNull { it.visibleBounds.top }
                        check(back?.visibleBounds?.height() == 48 && back.visibleBounds.width() == 48)
                        ScreenshotCapture.capture("conversation-model-picker.png")
                        captureFastPress(fast)
                    }
                } finally {
                    val cleanup = listOf(
                        runCatching {
                            auth.state.value = oldAuth
                            app.chatService = oldChat
                            app.composerService = oldComposer
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

    private fun event(seq: Long, kind: String, fields: Map<String, kotlinx.serialization.json.JsonElement>): String =
        JsonObject(Json.parseToJsonElement(chatEventWire(id = UUID.randomUUID().toString(), seq = seq, kind = kind)).jsonObject + fields).toString()

    private fun displayOverride(kind: String): String =
        device.executeShellCommand("wm $kind").lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(": ")?.trim() ?: "reset"

    private fun captureFastPress(fast: UiObject2) {
        val bounds = fast.visibleBounds
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
            device.waitForIdle()
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

    private fun action(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(object : androidx.test.uiautomator.Condition<UiDevice, UiObject2?> {
            override fun apply(device: UiDevice): UiObject2? =
                device.findObjects(selector).firstNotNullOfOrNull { clickable(it)?.takeIf { row -> row.isEnabled } }
        }, 12_000)) { "No enabled action for $selector" }
}
