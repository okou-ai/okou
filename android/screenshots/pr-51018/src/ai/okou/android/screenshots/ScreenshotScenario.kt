package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.os.LocaleList
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesChatListPointerAndKeyboardStates() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val automation = instrumentation.uiAutomation
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val preferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        fun row(title: String) =
            checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).text(title)), 12_000)) {
                "Missing list row: $title"
            }
        fun hover(x: Float, y: Float) {
            val time = SystemClock.uptimeMillis()
            val pointer = MotionEvent.PointerProperties().apply {
                id = 0
                toolType = MotionEvent.TOOL_TYPE_MOUSE
            }
            val coords = MotionEvent.PointerCoords().apply {
                this.x = x
                this.y = y
            }
            val event = MotionEvent.obtain(
                time, time, MotionEvent.ACTION_HOVER_MOVE, 1, arrayOf(pointer), arrayOf(coords),
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0,
            )
            try {
                check(automation.injectInputEvent(event, true))
                device.waitForIdle()
            } finally {
                event.recycle()
            }
        }
        val projectTitle = "用户研究"
        val chatTitle = "制定下周计划"
        val fixture = ChatListApiFixture()
        try {
            device.executeShellCommand("settings put system font_scale 1.0")
            app.initialPreferences = testPreferences().copy(
                locale = UserPreferencesLocale.ZH_HANS,
                theme = UserPreferencesTheme.LIGHT,
            )
            instrumentation.runOnMainSync { localeManager.applicationLocales = LocaleList.forLanguageTags("zh-Hans") }
            fixture.projects = {
                jsonResponse("""{"projects":[{"id":"$CHAT_PROJECT","name":"$projectTitle","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a0"}],"latestEventId":null,"latestSeqId":0}""")
            }
            fixture.events = { request ->
                val rows = if (request.requestUrl?.queryParameter("sinceSeqId") == null) chatEventWire(title = chatTitle) else ""
                jsonResponse("""{"events":[$rows],"hasMore":false}""")
            }
            app.chatService = fixture.service
            for (wide in listOf(false, true)) {
                device.executeShellCommand(if (wide) "wm size 1180x920" else "wm size 1080x1920")
                device.executeShellCommand(if (wide) "wm density 160" else "wm density 420")
                auth.state.value = testAuthenticationState(user = "row-feedback-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use {
                    try {
                        row(projectTitle)
                        val chat = row(chatTitle)
                        if (!wide) {
                            ScreenshotCapture.capture("phone-list.png")
                        } else {
                            chat.click()
                            check(device.wait(Until.hasObject(By.pkg(app.packageName).textContains("Native history")), 12_000)) {
                                "The selected chat did not open in the detail pane"
                            }
                            ScreenshotCapture.capture("wide-current.png")
                            val projectBounds = row(projectTitle).visibleBounds
                            hover(projectBounds.exactCenterX(), projectBounds.exactCenterY())
                            ScreenshotCapture.capture("wide-project-hover.png")
                            val chatBounds = row(chatTitle).visibleBounds
                            hover(chatBounds.exactCenterX(), chatBounds.exactCenterY())
                            ScreenshotCapture.capture("wide-current-hover.png")
                            hover(350f, 150f)
                            val projectFocused = By.focused(true).hasDescendant(By.text(projectTitle))
                            val focusedProjectLabel = By.text(projectTitle).focused(true)
                            for (step in 0 until 18) {
                                if (device.hasObject(projectFocused) || device.hasObject(focusedProjectLabel)) break
                                check(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
                            }
                            check(device.hasObject(projectFocused) || device.hasObject(focusedProjectLabel)) {
                                "Tab navigation did not reach the Project row"
                            }
                            ScreenshotCapture.capture("wide-keyboard-focus.png")
                        }
                    } catch (failure: Throwable) {
                        runCatching {
                            TestStorage().openOutputFile("diagnostic-hierarchy.xml").use(device::dumpWindowHierarchy)
                        }
                        throw failure
                    }
                }
            }
        } finally {
            fixture.close()
            auth.state.value = originalAuth
            app.chatService = originalChat
            app.restoreApiPreferences(preferences)
            app.initialPreferences = initialPreferences
            instrumentation.runOnMainSync { localeManager.applicationLocales = originalLocale }
            device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            device.executeShellCommand(if (fontScale == "null") "settings delete system font_scale" else "settings put system font_scale $fontScale")
            cache.restore()
        }
    }
}
