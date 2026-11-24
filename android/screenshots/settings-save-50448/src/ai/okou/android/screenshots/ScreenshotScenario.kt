package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun failedSettingsSaves() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalPreferences = app.initialPreferences
        val originalWrite = app.preferenceWrite
        val stored = app.snapshotApiPreferences()

        fun selector() = By.pkg(app.packageName)
        fun find(query: BySelector) =
            checkNotNull(device.wait(Until.findObject(query), 15_000)) { "Missing control $query" }
        fun text(label: String) = find(selector().text(label))
        fun openSettings() {
            find(selector().desc("设置")).click()
            text("设置")
        }
        fun reveal(label: String) {
            repeat(8) {
                if (device.hasObject(selector().text(label))) return
                find(selector().scrollable(true)).scroll(Direction.DOWN, 0.5f)
            }
            text(label)
        }
        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }

        ChatListApiFixture().use { api ->
            app.chatService = api.service
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Kathmandu",
                    )
            try {
                val attempts = AtomicInteger()
                app.preferenceWrite = { update, save ->
                    if (update.timezone != null) {
                        attempts.incrementAndGet()
                        throw ApiFailure.Http(500, null, null, null)
                    }
                    save()
                }
                auth.state.value =
                    testAuthenticationState(user = "settings-rollback-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use {
                    openSettings()
                    reveal("时区")
                    text("时区").click()
                    text("加德满都（UTC+5:45）")
                    capture("settings-timezone-picker.png")
                    text("比什凯克（UTC+6）").click()
                    text("未能保存时区，已恢复原值。")
                    text("加德满都（UTC+5:45）")
                    check(attempts.get() == 3) { "Expected three time zone write attempts" }
                    capture("settings-timezone-rollback.png")
                }

                app.preferenceWrite = { update, save ->
                    if (update.theme != null) throw ApiFailure.Http(400, "BAD_REQUEST", null, null)
                    save()
                }
                auth.state.value =
                    testAuthenticationState(user = "settings-appearance-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use {
                    openSettings()
                    reveal("显示模式")
                    text("显示模式").click()
                    text("深色").click()
                    text("外观未能同步，已应用到此设备。")
                    text("深色")
                    capture("settings-local-appearance.png")
                }
            } finally {
                app.preferenceWrite = originalWrite
                app.initialPreferences = originalPreferences
                app.restoreApiPreferences(stored)
                app.chatService = originalChats
                auth.state.value = originalAuth
            }
        }
    }
}
