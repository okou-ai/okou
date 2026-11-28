package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
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
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun defaultFontList() = capture("default", 1f)

    @Test
    fun largeFontList() = capture("large", 2f)

    private fun capture(name: String, scale: Float) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val priorAuth = auth.state.value
        val priorService = app.chatService
        val priorPreferences = app.snapshotApiPreferences()
        val priorSize = Regex("Override size: (\\d+x\\d+)")
            .find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val priorDensity = Regex("Override density: (\\d+)")
            .find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        val priorScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val release = CountDownLatch(1)
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }
        fun row(title: String) =
            checkNotNull(generateSequence(find(text(title))) { it.parent }.firstOrNull {
                it.isClickable && it.className == "android.widget.Button"
            }) { "Missing row for $title" }
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 440x940")
            device.executeShellCommand("settings put system font_scale $scale")
            ChatListApiFixture().use { fixture ->
                app.chatService = fixture.service
                fixture.beforeResponse = { check(release.await(20, TimeUnit.SECONDS)) }
                auth.state.value = testAuthenticationState(user = "scaled-list-$name-${UUID.randomUUID()}")
                try {
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        scenario.onActivity { check(it.resources.configuration.fontScale == scale) }
                        device.awaitChatList(app)
                        val loading = By.pkg(app.packageName).desc(app.getString(R.string.chat_loading))
                        val skeleton = find(loading).visibleBounds
                        check(skeleton.height() % 6 == 0) { "Expected six complete skeleton rows, got $skeleton" }
                        val height = skeleton.height() / 6
                        check(if (scale == 1f) height == 56 else height > 56) {
                            "Wrong placeholder row height $height at font scale $scale"
                        }
                        ScreenshotCapture.capture("$name-loading.png")

                        release.countDown()
                        val project = row("Research").visibleBounds
                        val chat = row("Personal chat").visibleBounds
                        check(device.wait(Until.gone(loading), 10_000))
                        check(project.top == skeleton.top && project.height() == height) {
                            "Project row $project differs from the first placeholder at $skeleton / $height"
                        }
                        check(chat.top == project.bottom && chat.height() == height) {
                            "Chat row $chat differs from the second placeholder at $skeleton / $height"
                        }
                        ScreenshotCapture.capture("$name-loaded.png")
                    }
                } finally {
                    release.countDown()
                }
            }
        } finally {
            release.countDown()
            auth.state.value = priorAuth
            app.chatService = priorService
            app.restoreApiPreferences(priorPreferences)
            device.executeShellCommand("wm size ${priorSize ?: "reset"}")
            device.executeShellCommand("wm density ${priorDensity ?: "reset"}")
            device.executeShellCommand(
                if (priorScale == "null") "settings delete system font_scale"
                else "settings put system font_scale $priorScale",
            )
            cache.restore()
        }
    }
}
