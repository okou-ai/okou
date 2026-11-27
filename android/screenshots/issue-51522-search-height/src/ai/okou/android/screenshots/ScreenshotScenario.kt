package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.os.LocaleList
import android.util.TypedValue
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun searchEntryAndEditorStayAligned() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val chats = app.chatService
        val preferences = app.snapshotApiPreferences()
        val initial = app.initialPreferences
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val size = device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val density = device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val font = device.executeShellCommand("settings get system font_scale").trim()
        val ime = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val localized = app.createConfigurationContext(
            Configuration(app.resources.configuration).apply { setLocales(LocaleList.forLanguageTags("zh-Hans")) },
        )
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
        fun desc(id: Int) = By.pkg(app.packageName).desc(localized.getString(id))
        fun restore(scope: String, key: String, value: String) {
            if (value.toFloatOrNull() == null) device.executeShellCommand("settings delete $scope $key")
            else device.executeShellCommand("settings put $scope $key $value")
        }
        fun imeVisible(visible: Boolean) {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) =
                    instrumentation.uiAutomation.windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } == visible
            }, 8_000)) { "Expected IME visible=$visible" }
        }
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            for (scale in listOf(1f, 2f)) {
                device.executeShellCommand("settings put system font_scale $scale")
                for (wide in listOf(false, true)) {
                    val layout = (if (wide) "wide" else "phone") + if (scale == 1f) "" else "-large"
                    val geometry = if (wide) "1000x800" else "412x892"
                    device.executeShellCommand("wm size $geometry")
                    auth.state.value = testAuthenticationState(user = "search-height-${UUID.randomUUID()}")
                    app.initialPreferences = testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT,
                    )
                    ChatListApiFixture().use { fixture ->
                        app.chatService = fixture.service
                        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                            device.awaitChatList(app)
                            var expectedHeight = 0
                            scenario.onActivity {
                                assertEquals(scale, it.resources.configuration.fontScale, 0f)
                                expectedHeight = maxOf(48, TypedValue.applyDimension(
                                    TypedValue.COMPLEX_UNIT_SP, 24f, it.resources.displayMetrics,
                                ).roundToInt() + 16)
                            }
                            val entry = get(desc(R.string.chat_search_workspace).clickable(true))
                            val home = entry.visibleBounds
                            assertEquals(expectedHeight, home.height())
                            ScreenshotCapture.capture("home-$layout.png")
                            entry.click()
                            val editor = By.pkg(app.packageName).clazz("android.widget.EditText")
                                .desc(localized.getString(R.string.chat_search_workspace))
                            val input = get(editor.focused(true))
                            imeVisible(true)
                            fun checkInput() {
                                val bounds = get(editor).visibleBounds
                                assertEquals(home.top, bounds.top)
                                assertEquals(home.left, bounds.left)
                                assertEquals(expectedHeight, bounds.height())
                            }
                            checkInput()
                            input.text = "project"
                            get(desc(R.string.chat_search_clear)).click()
                            checkInput()
                            get(editor.focused(true))
                            assertTrue(device.pressBack())
                            imeVisible(false)
                            checkInput()
                            ScreenshotCapture.capture("search-$layout.png")
                            assertTrue(device.pressBack())
                            device.awaitChatList(app)
                            assertEquals(home, get(desc(R.string.chat_search_workspace).clickable(true)).visibleBounds)
                        }
                    }
                }
            }
        } finally {
            app.chatService = chats
            auth.state.value = originalAuth
            app.restoreApiPreferences(preferences)
            app.initialPreferences = initial
            cache.restore()
            restore("system", "font_scale", font)
            restore("secure", "show_ime_with_hard_keyboard", ime)
            device.executeShellCommand("wm size ${size.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${density.ifEmpty { "reset" }}")
        }
    }
}
