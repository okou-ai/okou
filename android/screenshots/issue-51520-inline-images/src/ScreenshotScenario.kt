package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.InlineImageFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.testAuthenticationState
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import kotlin.math.abs
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun opensAssistantImagesInReplyOrder() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val size = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))
            ?.groupValues?.get(1) ?: "reset"
        val density = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))
            ?.groupValues?.get(1) ?: "reset"
        fun desc(label: String) = By.pkg(app.packageName).desc(label)
        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun await(selector: BySelector) = checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
            "Missing native node: $selector"
        }
        fun page(index: Int) = await(desc(app.getString(R.string.artifact_image_page_description, index, 3)))
        fun openable(label: String): UiObject2 =
            checkNotNull(device.wait(object : Condition<UiDevice, UiObject2?> {
                override fun apply(device: UiDevice): UiObject2? =
                    generateSequence(device.findObject(desc(label))) { it.parent }
                        .firstOrNull { it.isClickable }
            }, 12_000)) { "No clickable image: $label" }
        fun checkToolbar(index: Int, paneStart: Int) {
            val counter = page(index).visibleBounds
            val back = generateSequence(await(desc(app.getString(R.string.back)))) { it.parent }
                .first { it.isClickable }.visibleBounds
            check(back.left == paneStart + 12 && back.width() == 48 && back.height() == 48) { "$back" }
            check(abs(counter.centerX() - (device.displayWidth + paneStart) / 2) <= 1) { "$counter" }
            check(counter.centerY() == back.centerY())
        }

        ComposerApiFixture(simulateHistory = false).use { api ->
            val fixture = InlineImageFixture(api.chats)
            val ready = "/artifacts/${fixture.readyReference}"
            val second = "/artifacts/${fixture.earlierReference}"
            fixture.install(
                earlier = false,
                latest = """
                    ![Rollout overview]($ready)

                    - ![Checklist details]($second)
                    - [![Open rollout link]($ready)](https://example.com/rollout)

                    | Release |
                    | --- |
                    | ![Final chart]($ready) |
                """.trimIndent(),
            )
            try {
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("wm size 412x892")
                app.chatService = api.service
                auth.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use {
                    try {
                        await(text("Personal chat")).click()
                        await(desc("Checklist details"))
                        check(device.swipe(206, 185, 206, 670, 28))
                        openable("Rollout overview").click()
                        checkToolbar(1, 0)
                        await(desc("Rollout overview").clickable(false))
                        ScreenshotCapture.capture("01-reply-image.png")
                        check(device.swipe(350, 480, 61, 480, 24))
                        page(2)
                        await(desc("Checklist details"))
                        ScreenshotCapture.capture("02-list-image.png")
                        check(device.pressKeyCode(KeyEvent.KEYCODE_DPAD_RIGHT))
                        page(3)
                        await(desc("Final chart"))
                        device.executeShellCommand("wm size 1000x1000")
                        await(desc(app.getString(R.string.artifact_image_expand)))
                        checkToolbar(3, 320)
                        await(desc("Final chart"))
                        ScreenshotCapture.capture("03-table-image-wide.png")
                        check(device.pressBack())
                        openable("Rollout overview")
                        ScreenshotCapture.capture("04-return-to-reply.png")
                    } catch (error: Throwable) {
                        runCatching {
                            ScreenshotCapture.capture("diagnostic.png")
                            TestStorage().openOutputFile("diagnostic.xml").use(device::dumpWindowHierarchy)
                        }
                        throw error
                    }
                }
            } finally {
                device.executeShellCommand("wm size $size")
                device.executeShellCommand("wm density $density")
                auth.state.value = previousAuth
                app.chatService = previousChats
                app.restoreApiPreferences(preferences)
                cache.restore()
            }
        }
    }
}
