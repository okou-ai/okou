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
import ai.okou.android.testAuthenticationState
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
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun changesDraftModelAndSubmitsTheSelectedEffortAndTier() = withFixture { fixture, defaults ->
        ActivityScenario.launch(MainActivity::class.java).use {
            device.awaitChatList(app)
            item(By.text("New chat")).click()
            action(By.desc(app.getString(R.string.chat_options_title))).click()
            val model = By.text(app.getString(R.string.chat_options_model))
            await("confirmed default model row") {
                clickable(device.findObject(model))?.isEnabled == true &&
                    device.hasObject(By.text("GPT 5.6 Sol"))
            }
            val modelRow = action(model)
            check(modelRow.visibleBounds.height() == 72) { "Model row: ${modelRow.visibleBounds}" }
            action(By.text(app.getString(R.string.connector_title)))
            ScreenshotCapture.capture("01-draft-model-entry.png")
            modelRow.click()
            val auto = action(By.text(app.getString(R.string.settings_auto_model))).visibleBounds
            check(auto.height() == 72) { "Auto option bounds: $auto" }

            val gpt = By.text("GPT 5.6 Sol")
            val claude = By.text("Claude Sonnet 5")
            val fast = By.text(app.getString(R.string.settings_model_fast))
            val medium = By.text(app.getString(R.string.settings_model_effort_medium))
            val high = By.text(app.getString(R.string.settings_model_effort_high))
            val row = action(gpt).visibleBounds
            check(row.height() == 56) { "Model option bounds: $row" }
            action(claude).click()
            await("Claude's remembered effort") { device.hasObject(high) && !device.hasObject(fast) }
            action(gpt).click()
            action(medium).click()
            action(high).click()
            action(fast).click()
            await("fast mode enabled") { clickable(device.findObject(fast))?.isChecked == true }
            action(claude).click()
            await("fast mode unavailable on Claude") { !device.hasObject(fast) }
            action(gpt).click()
            await("remembered High effort and reset fast mode") {
                device.hasObject(high) && clickable(device.findObject(fast))?.isChecked == false
            }
            action(fast).click()
            await("selected High effort and Fast mode") {
                device.hasObject(high) && clickable(device.findObject(fast))?.isChecked == true
            }
            val fastBounds = action(fast).visibleBounds
            check(fastBounds.height() >= 72) { "Fast switch row: $fastBounds" }
            ScreenshotCapture.capture("02-draft-model-advanced.png")

            val back = checkNotNull(device.findObjects(By.desc(app.getString(R.string.back)))
                .mapNotNull(::clickable).maxByOrNull { it.visibleBounds.top })
            check(back.visibleBounds.height() == 48) { "Picker back bounds: ${back.visibleBounds}" }
            back.click()
            await("return to the model row") { clickable(device.findObject(model))?.isEnabled == true }
            check(device.pressBack())
            await("return to the chat editor") { !device.hasObject(model) }
            item(By.clazz("android.widget.EditText").pkg(app.packageName)).text = "Use the draft model"
            action(By.desc(app.getString(R.string.composer_send))).click()
            await("first send delivered") { fixture.inputs.isNotEmpty() }
            val request = fixture.created.single()
            check(request["model"]?.jsonPrimitive?.content == "gpt-test")
            check(request["reasoningEffort"]?.jsonPrimitive?.content == "high")
            check(request["serviceTier"]?.jsonPrimitive?.content == "priority")
            check(defaults.writes.isEmpty())
        }
    }

    private fun withFixture(test: (ComposerApiFixture, DefaultModelApiFixture) -> Unit) {
        val size = displayOverride("size")
        val density = displayOverride("density")
        val font = device.executeShellCommand("settings get system font_scale").trim()
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val chat = app.chatService
        val composer = app.composerService
        val controls = app.controlService
        val recovery = app.recoveryService
        val connectorService = app.connectorService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ComposerApiFixture().use { fixture ->
            val defaults = DefaultModelApiFixture(fixture.chats)
            val connectors = ConnectorApiFixture()
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.controlService = fixture.service
            app.recoveryService = fixture.service
            app.connectorService = connectors.service
            auth.state.value = testAuthenticationState(user = "draft-model-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                test(fixture, defaults)
            } finally {
                val cleanup = listOf(
                    runCatching { cache.restore() },
                    runCatching {
                        auth.state.value = oldAuth
                        app.chatService = chat
                        app.composerService = composer
                        app.controlService = controls
                        app.recoveryService = recovery
                        app.connectorService = connectorService
                        app.restoreApiPreferences(preferences)
                    },
                    runCatching { connectors.close() },
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

    private fun displayOverride(kind: String) = device.executeShellCommand("wm $kind").lineSequence()
        .firstOrNull { it.startsWith("Override") }?.substringAfter(": ")?.trim() ?: "reset"

    private fun item(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "No node for $selector" }

    private fun clickable(item: UiObject2?): UiObject2? =
        generateSequence(item) { it.parent }.firstOrNull { it.isClickable }

    private fun action(selector: BySelector): UiObject2 =
        checkNotNull(clickable(item(selector))) { "No clickable node for $selector" }

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
