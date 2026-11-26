package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
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
import android.content.res.Configuration
import android.os.LocaleList
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesKeyboardFocusedChatListControls() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val preferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val locale = LocaleList.forLanguageTags("zh-Hans")
        val resources =
            app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocales(locale) })
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        val fixture = ChatListApiFixture()
        val projectTitle = "用户研究"
        val chatTitle = "制定下周计划"
        val measurements = JSONArray()

        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun label(id: Int) = resources.getString(id)
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
        fun focused(label: String, description: Boolean = false): UiObject2? {
            fun selector() = if (description) By.desc(label) else By.text(label)
            return device.findObject(selector().pkg(app.packageName).focused(true))
                ?: device.findObject(By.pkg(app.packageName).focused(true).hasDescendant(selector()))
        }
        fun press(key: Int) {
            check(device.pressKeyCode(key)) { "Key input failed: $key" }
        }
        fun focus(label: String, description: Boolean = false, key: Int = KeyEvent.KEYCODE_TAB) {
            repeat(30) {
                if (focused(label, description) != null) return
                press(key)
            }
            check(focused(label, description) != null) { "Keyboard did not reach $label" }
        }
        fun capture(file: String, label: String, description: Boolean = false) {
            val bounds = checkNotNull(focused(label, description)) { "Expected focus on $label" }.visibleBounds
            measurements.put(
                JSONObject().put("file", file).put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom))),
            )
            ScreenshotCapture.capture(file)
        }

        try {
            device.executeShellCommand("settings put system font_scale 1.0")
            app.initialPreferences = testPreferences().copy(
                locale = UserPreferencesLocale.ZH_HANS,
                theme = UserPreferencesTheme.LIGHT,
            )
            instrumentation.runOnMainSync { localeManager.applicationLocales = locale }
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
                auth.state.value = testAuthenticationState(user = "list-control-focus-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use {
                    try {
                        find(text(projectTitle))
                        find(text(chatTitle))
                        val filter = label(R.string.chat_filter)
                        focus(filter, description = true)
                        press(KeyEvent.KEYCODE_ENTER)
                        val archived = label(R.string.chat_archived)
                        find(text(archived))
                        focus(archived, key = KeyEvent.KEYCODE_DPAD_DOWN)
                        press(KeyEvent.KEYCODE_ENTER)
                        find(text(label(R.string.chat_empty_archived)))
                        check(focused(filter, description = true) != null) { "Filter focus did not return" }
                        if (!wide) capture("phone-filter-focus.png", filter, description = true)
                        val backToInbox = label(R.string.chat_back_to_inbox)
                        focus(backToInbox)
                        if (!wide) capture("phone-inbox-focus.png", backToInbox)
                        press(KeyEvent.KEYCODE_ENTER)
                        find(text(chatTitle))

                        if (wide) {
                            val more = label(R.string.chat_more_actions)
                            focus(more, description = true)
                            capture("wide-more-focus.png", more, description = true)
                            press(KeyEvent.KEYCODE_ENTER)
                            val settings = text(label(R.string.settings))
                            find(settings)
                            press(KeyEvent.KEYCODE_ESCAPE)
                            check(device.wait(Until.gone(settings), 5_000)) { "More remained open" }
                            check(focused(more, description = true) != null) { "More focus did not return" }

                            focus(projectTitle)
                            press(KeyEvent.KEYCODE_ENTER)
                            val newProjectChat = label(R.string.composer_new_project)
                            find(text(newProjectChat))
                            focus(newProjectChat)
                            capture("wide-project-focus.png", newProjectChat)
                            press(KeyEvent.KEYCODE_ENTER)
                            device.waitForIdle()
                            check(device.findObjects(text(projectTitle)).any { it.visibleBounds.left > 344 }) {
                                "The Project draft did not open in the detail pane"
                            }

                            val newChat = label(R.string.composer_new)
                            focus(newChat)
                            capture("wide-new-chat-focus.png", newChat)
                            press(KeyEvent.KEYCODE_ENTER)
                            device.waitForIdle()
                            check(device.findObjects(text(projectTitle)).none { it.visibleBounds.left > 344 }) {
                                "New Chat did not leave the Project draft"
                            }
                        }
                    } catch (failure: Throwable) {
                        runCatching {
                            TestStorage().openOutputFile("diagnostic-hierarchy.xml").use(device::dumpWindowHierarchy)
                        }
                        throw failure
                    }
                }
            }
            TestStorage().openOutputFile("focus-bounds.json").use {
                it.write(measurements.toString().toByteArray(Charsets.UTF_8))
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
