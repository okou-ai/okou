package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.InlineImageFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import android.graphics.Color
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlin.math.abs
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun opensTheOriginalAndExpandsTheEarlierReply() = withChat { fixture ->
        fixture.install()
        openConversation {
            val image = By.desc(fixture.readyAlt)
            val bounds = paintedImage(image)
            check(bounds.width() == 240 && bounds.height() == 216) { "Inline frame measured $bounds" }
            check(fixture.thumbnails == listOf(fixture.readyReference))
            check(fixture.originals.isEmpty() && fixture.earlierReference !in fixture.references)
            ScreenshotCapture.capture("01-inline-image.png")
            capturePress(bounds)
            item(image).click()
            val original = paintedImage(By.desc(fixture.filename))
            check(original.width() > bounds.width()) { "Original did not use the shared preview area" }
            check(fixture.originals == listOf(fixture.readyReference))
            ScreenshotCapture.capture("03-original-preview.png")

            item(By.desc(app.getString(ai.okou.android.R.string.back))).click()
            check(paintedImage(image) == bounds) { "Back changed the image's reading position" }
            check(fixture.thumbnails == listOf(fixture.readyReference))
            item(By.textContains("2 steps")).click()
            val earlier = By.desc(fixture.earlierAlt)
            repeat(3) {
                if (!device.hasObject(earlier)) device.swipe(200, 230, 200, 641, 20)
            }
            val older = paintedImage(earlier)
            check(older.left > bounds.left && fixture.earlierReference in fixture.thumbnails)
            ScreenshotCapture.capture("04-earlier-reply.png")
        }
    }

    @Test
    fun keepsMissingAndRestrictedImagesInTheirFrames() = withChat { fixture ->
        fixture.missingThumbnail = true
        fixture.install(
            latest =
                "These are the two source images.\n\n" +
                    "![${fixture.readyAlt}](/artifacts/${fixture.readyReference})\n\n" +
                    "![${fixture.deniedAlt}](/artifacts/${fixture.deniedReference})",
            earlier = false,
        )
        openConversation {
            val available = By.desc(fixture.readyAlt)
            val denied = By.desc(fixture.deniedAlt)
            await {
                device.findObject(available) != null && device.findObject(denied) != null &&
                    fixture.references.containsAll(listOf(fixture.readyReference, fixture.deniedReference))
            }
            val first = item(available).visibleBounds
            val second = item(denied).visibleBounds
            check(first.width() == 240 && first.height() == 216 && second.height() == 216)
            check(second.top - first.bottom == 12) { "Frames did not stay 12dp apart" }
            check(fixture.thumbnails.isEmpty() && fixture.originals.isEmpty())
            ScreenshotCapture.capture("05-image-states.png")
        }
    }

    @Test
    fun keepsTableGeometryAndExternalLinkAtLargeFontScale() = withChat(
        size = "360x890",
        fontScale = "2.0",
    ) { fixture ->
        fixture.install(
            latest =
                "Rollout references\n\n" +
                    "| Evidence | Note | Source |\n| --- | --- | --- |\n" +
                    "| [![${fixture.readyAlt}](/artifacts/${fixture.readyReference})](https://example.com/report) | Passed | Staging |",
            earlier = false,
        )
        openConversation {
            val image = paintedImage(By.desc(fixture.readyAlt))
            check(image.width() >= 144 && abs(image.width() * .9 - image.height()) <= 1.0)
            check(fixture.originals.isEmpty())
            ScreenshotCapture.capture("06-table-large-text.png")
        }
    }

    private fun withChat(size: String = "412x892", fontScale: String = "1.0", test: (InlineImageFixture) -> Unit) {
        val originalSize = displayValue("size")
        val originalDensity = displayValue("density")
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val originalComposer = app.composerService
        val originalControls = app.controlService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            app.chatService = api.service
            app.composerService = api.service
            app.controlService = api.service
            auth.state.value = testAuthenticationState(user = "inline-images-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size $size")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale $fontScale")
                test(InlineImageFixture(api))
            } finally {
                try {
                    cache.restore()
                } finally {
                    auth.state.value = originalAuth
                    app.chatService = originalChat
                    app.composerService = originalComposer
                    app.controlService = originalControls
                    device.executeShellCommand("wm size $originalSize")
                    device.executeShellCommand("wm density $originalDensity")
                    if (originalFont.toFloatOrNull() == null)
                        device.executeShellCommand("settings delete system font_scale")
                    else device.executeShellCommand("settings put system font_scale $originalFont")
                }
            }
        }
    }

    private fun openConversation(test: () -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use {
            device.awaitChatList(app)
            item(By.text("Personal chat")).click()
            test()
        }
    }

    private fun displayValue(kind: String): String {
        val output = device.executeShellCommand("wm $kind")
        return output.lineSequence()
            .firstOrNull { it.startsWith("Override") }
            ?.substringAfter(": ")?.trim() ?: "reset"
    }

    private fun item(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000))

    private fun await(condition: () -> Boolean) {
        if (!device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean = condition()
        }, 12_000)) {
            val hierarchy = ByteArrayOutputStream()
            device.dumpWindowHierarchy(hierarchy)
            ScreenshotCapture.capture("diagnostic-unexpected-state.png")
            error("The expected native state did not appear. ${hierarchy.toString(Charsets.UTF_8.name())}")
        }
    }

    private fun paintedImage(selector: BySelector): Rect {
        await {
            val bounds = device.findObject(selector)?.visibleBounds ?: return@await false
            bounds.width() > 40 && bounds.height() > 40 &&
                pixel(bounds.right - 10, bounds.centerY()) == Color.parseColor("#F9F4EF")
        }
        return item(selector).visibleBounds
    }

    private fun pixel(x: Int, y: Int): Int {
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        return try { image.getPixel(x, y) } finally { image.recycle() }
    }

    private fun capturePress(bounds: Rect) {
        val x = bounds.right - 10
        val y = bounds.centerY()
        val before = pixel(x, y)
        val downTime = SystemClock.uptimeMillis()
        fun inject(action: Int) {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x.toFloat(), y.toFloat(), 0)
            try {
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                check(instrumentation.uiAutomation.injectInputEvent(event, true))
            } finally {
                event.recycle()
            }
        }
        inject(MotionEvent.ACTION_DOWN)
        try {
            await { pixel(x, y) != before }
            ScreenshotCapture.capture("02-image-pressed.png")
        } finally {
            inject(MotionEvent.ACTION_CANCEL)
        }
        await { pixel(x, y) == before }
    }
}
