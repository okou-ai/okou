package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.openChatListSettings
import ai.okou.android.settings.BuiltInToolsService
import ai.okou.android.settings.DataToolFamily
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlin.math.roundToInt
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun settingsPanelsOpenAtTheirSelectedOptions() {
        val auth = app.authentication as TestAuthentication
        val originalSession = auth.state.value
        val originalChat = app.chatService
        val originalRecovery = app.recoveryService
        val originalPreferences = app.snapshotApiPreferences()
        val originalTools = app.builtInToolsService
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocales = localeManager.applicationLocales
        val originalSize = override("wm size", Regex("[0-9]+x[0-9]+"))
        val originalDensity = override("wm density", Regex("[0-9]+"))
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        ChatListApiFixture().use { api ->
            try {
                app.chatService = api.service
                app.recoveryService = api.service
                app.builtInToolsService = ImageModelFixture()
                val user = "settings-choice-${UUID.randomUUID()}"
                auth.state.value = testAuthenticationState(user = user)
                app.restoreApiPreferences(
                    mapOf(
                        Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                            testPreferences().copy(
                                locale = UserPreferencesLocale.ZH_HANT,
                                theme = UserPreferencesTheme.LIGHT,
                                colorTheme = UserPreferencesColorTheme.DEEP_LAGOON,
                                timezone = "Asia/Kathmandu",
                            ),
                    ),
                )
                localeManager.applicationLocales = LocaleList.forLanguageTags("zh-Hant")
                device.executeShellCommand("wm density 420")
                device.executeShellCommand("wm size 1080x1260")
                device.executeShellCommand("settings put system font_scale 1.0")
                settings(1f) {
                    open(R.string.preference_language)
                    val language = option(R.string.language_zh_hant)
                    awaitSelected(language)
                    check(instrumentation.uiAutomation.clearCache())
                    check(!device.hasObject(option(R.string.language_en_us)))
                    capture("01-language-selected.png")
                    dismiss(language)
                    open(R.string.settings_timezone)
                    val zone = option(By.pkg(app.packageName).textContains("UTC+5:45"))
                    awaitSelected(zone)
                    capture("02-timezone-selected.png")
                    dismiss(zone)
                    open(R.string.settings_built_in_tools)
                    open(R.string.settings_tool_image_model)
                    val image = awaitSelected(option(label("Seedream 4")))
                    check(image.findObject(label("\$\$")) != null)
                    capture("06-image-model.png")
                }

                device.executeShellCommand("wm size 1080x1920")
                settings(1f) {
                    open(R.string.preference_color_theme)
                    val selection = option(R.string.palette_deep_lagoon)
                    val deep = awaitSelected(selection)
                    val daydream = await(option(R.string.palette_daydream))
                    check(deep.visibleBounds.centerY() == daydream.visibleBounds.centerY())
                    capture("03-palette-two-columns.png")
                    dismiss(selection)
                    open(R.string.appearance)
                    awaitSelected(option(R.string.appearance_light))
                    capture("05-display-mode.png")
                }

                device.executeShellCommand("wm size 1080x1260")
                device.executeShellCommand("settings put system font_scale 1.6")
                settings(1.6f) {
                    open(R.string.preference_color_theme)
                    val deep = awaitSelected(option(R.string.palette_deep_lagoon))
                    val daydream = await(option(R.string.palette_daydream))
                    check(deep.visibleBounds.top >= daydream.visibleBounds.bottom)
                    capture("04-palette-large-text.png")
                }
            } finally {
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
                if (Regex("[0-9]+(\\.[0-9]+)?").matches(originalFont)) {
                    device.executeShellCommand("settings put system font_scale $originalFont")
                } else {
                    device.executeShellCommand("settings delete system font_scale")
                }
                localeManager.applicationLocales = originalLocales
                auth.state.value = originalSession
                app.chatService = originalChat
                app.recoveryService = originalRecovery
                app.restoreApiPreferences(originalPreferences)
                app.builtInToolsService = originalTools
            }
        }
    }

    private fun settings(fontScale: Float, block: () -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            try {
                device.awaitChatList(app)
                val ready = object : Condition<UiDevice, Boolean> {
                    override fun apply(unused: UiDevice): Boolean {
                        var matched = false
                        scenario.onActivity {
                            val config = it.resources.configuration
                            matched = config.fontScale == fontScale &&
                                config.locales[0].toLanguageTag().startsWith("zh-Hant")
                        }
                        return matched
                    }
                }
                check(device.wait(ready, 12_000) == true)
                device.openChatListSettings(app)
                block()
            } catch (error: Throwable) {
                try {
                    takeScreenshot().writeToTestStorage("settings-choice-diagnostic")
                } catch (diagnostic: Throwable) {
                    error.addSuppressed(diagnostic)
                }
                throw error
            }
        }
    }

    private fun override(command: String, pattern: Regex): String? =
        device.executeShellCommand(command).lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(": ")?.takeIf(pattern::matches)

    private fun label(value: String) = By.pkg(app.packageName).text(value)

    private fun option(resource: Int) = option(label(app.getString(resource)))

    private fun option(label: BySelector) =
        By.pkg(app.packageName).checkable(true).hasDescendant(label)

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }

    private fun awaitSelected(selector: BySelector): UiObject2 {
        val minHeight = (56 * app.resources.displayMetrics.density).roundToInt()
        val ready = object : Condition<UiDevice, UiObject2?> {
            override fun apply(device: UiDevice): UiObject2? =
                device.findObject(selector)?.takeIf {
                    it.isChecked && it.visibleBounds.height() >= minHeight
                }
        }
        return checkNotNull(device.wait(ready, 12_000)) {
            "Expected a fully visible selected row of at least ${minHeight}px for $selector"
        }
    }

    private fun open(resource: Int) {
        val selector =
            By.pkg(app.packageName).clickable(true).checkable(false).enabled(true)
                .hasDescendant(label(app.getString(resource)))
        if (!device.hasObject(selector)) {
            val scroll = await(By.pkg(app.packageName).scrollable(true))
            val visible = object : Condition<UiObject2, Boolean> {
                override fun apply(unused: UiObject2) = device.hasObject(selector)
            }
            if (scroll.scrollUntil(Direction.DOWN, visible) != true) {
                scroll.scrollUntil(Direction.UP, visible)
            }
        }
        await(selector).click()
    }

    private fun dismiss(selection: BySelector) {
        check(device.pressBack())
        check(device.wait(Until.gone(selection), 12_000) == true)
    }

    private fun capture(name: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(name)
    }

    private class ImageModelFixture : BuiltInToolsService {
        override suspend fun catalog(): List<DataToolFamily> = emptyList()

        override suspend fun disabledTools(): Set<String> = emptySet()

        override suspend fun setEnabled(id: String, enabled: Boolean) = enabled

        override suspend fun imageModel() = "fal-ai/bytedance/seedream/v4/text-to-image"

        override suspend fun selectImageModel(id: String) = id
    }
}
