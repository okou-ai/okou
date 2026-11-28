package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.graphics.Rect
import android.os.LocaleList
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.json.JSONArray
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun selectedChatKeepsFilledSwipeCorners() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val priorAuth = auth.state.value
        val priorService = app.chatService
        val priorPreferences = app.snapshotApiPreferences()
        val priorInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val priorLocales = localeManager.applicationLocales
        val priorSize = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))
            ?.groupValues?.get(1)
        val priorDensity = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))
            ?.groupValues?.get(1)
        val priorFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val captures = JSONArray()
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 920x760")
            device.executeShellCommand("settings put system font_scale 1.0")
            app.initialPreferences = testPreferences().copy(
                theme = UserPreferencesTheme.DARK,
                locale = UserPreferencesLocale.ZH_HANS,
                colorTheme = UserPreferencesColorTheme.DEEP_LAGOON,
            )
            instrumentation.runOnMainSync { localeManager.applicationLocales = LocaleList.forLanguageTags("zh-Hans") }
            auth.state.value = testAuthenticationState(user = "swipe-label-${UUID.randomUUID()}")
            ChatListApiFixture().use { fixture ->
                app.chatService = fixture.service
                ActivityScenario.launch(MainActivity::class.java).use { activityScenario ->
                    val row = By.pkg(app.packageName).text("Personal chat")
                    val selected = checkNotNull(device.wait(Until.findObject(row), 15_000))
                    val bounds = selected.visibleBounds
                    check(bounds.centerX() < device.displayWidth / 2)
                    selected.click()
                    check(device.wait(Until.hasObject(By.pkg(app.packageName).desc("聊天操作")), 10_000))
                    fun visibleRow(): Rect? =
                        device.findObjects(row).map { it.visibleBounds }
                            .firstOrNull { it.centerX() < device.displayWidth / 2 }
                    val x = bounds.exactCenterX()
                    val y = bounds.exactCenterY()
                    val pointer = MotionEvent.PointerProperties().apply {
                        id = 0
                        toolType = MotionEvent.TOOL_TYPE_FINGER
                    }
                    // Hold each position in the real Activity without input resampling.
                    fun send(down: Long, action: Int, position: Float) {
                        activityScenario.onActivity { activity ->
                            val origin = IntArray(2)
                            activity.window.decorView.getLocationOnScreen(origin)
                            val coords = MotionEvent.PointerCoords().apply {
                                this.x = position - origin[0]
                                this.y = y - origin[1]
                                pressure = 1f
                                size = 1f
                            }
                            val event = MotionEvent.obtain(
                                down, SystemClock.uptimeMillis(), action, 1, arrayOf(pointer), arrayOf(coords),
                                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
                            )
                            try {
                                activity.dispatchTouchEvent(event)
                            } finally {
                                event.recycle()
                            }
                        }
                    }
                    for ((direction, name) in listOf(-1 to "archive", 1 to "read")) {
                        val down = SystemClock.uptimeMillis()
                        send(down, MotionEvent.ACTION_DOWN, x)
                        var position = x
                        try {
                            for ((width, phase) in listOf(104 to "ready")) {
                                position = x + width * direction
                                send(down, MotionEvent.ACTION_MOVE, position)
                                val moved = device.wait(
                                    object : Condition<UiDevice, Rect?> {
                                        override fun apply(device: UiDevice): Rect? {
                                            val current = visibleRow() ?: return null
                                            val reveal = if (direction < 0) bounds.right - current.right
                                                else current.left - bounds.left
                                            return current.takeIf { reveal in (width - 3)..(width + 3) }
                                        }
                                    },
                                    5_000,
                                )
                                ScreenshotCapture.capture("$name-$phase.png")
                                checkNotNull(moved) {
                                    "Missing $name $phase reveal: before $bounds, after ${visibleRow()}"
                                }
                                captures.put("$name-$phase ${moved.toShortString()}")
                            }
                        } finally {
                            send(down, MotionEvent.ACTION_CANCEL, position)
                        }
                        check(device.wait(
                            object : Condition<UiDevice, Boolean> {
                                override fun apply(device: UiDevice) = visibleRow() == bounds
                            },
                            5_000,
                        ))
                    }
                    ScreenshotCapture.capture("row-restored.png")
                }
            }
            TestStorage().openOutputFile("swipe-evidence.json").use {
                it.write(captures.toString().toByteArray(Charsets.UTF_8))
            }
        } finally {
            auth.state.value = priorAuth
            app.chatService = priorService
            app.restoreApiPreferences(priorPreferences)
            app.initialPreferences = priorInitialPreferences
            instrumentation.runOnMainSync { localeManager.applicationLocales = priorLocales }
            device.executeShellCommand("wm size ${priorSize ?: "reset"}")
            device.executeShellCommand("wm density ${priorDensity ?: "reset"}")
            device.executeShellCommand(
                if (priorFontScale == "null") "settings delete system font_scale"
                else "settings put system font_scale $priorFontScale",
            )
            cache.restore()
        }
    }
}
