package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.InlineImageFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.historyEventWire
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
import kotlinx.serialization.json.JsonPrimitive
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

    @Test
    fun showsNativeRipplesOnTheWorkSummaryAndSuggestion() = withApi { api ->
        val suggestion = "Turn the rollout notes into a launch checklist"
        val earlier = "I checked the release notes and deployment checklist."
        val followups = """{"version":1,"followups":[{"kind":"talk","prompt":${JsonPrimitive(suggestion)}}]}"""
        fun event(seq: Long, type: String, payload: String) = historyEventWire(
            id = "50647000-0000-4000-8000-${seq.toString().padStart(12, '0')}",
            seq = seq,
            type = type,
            payload = payload,
            createdAt = "2026-11-24T16:00:0${seq}Z",
        )
        api.setHistoryEvents(CHAT_PERSONAL, listOf(
            event(1, "input.prompt", """{"userMessage":{"version":1,"parts":[{"type":"text","text":"How did the rollout go?"}]}}"""),
            event(2, "output.message", """{"content":${JsonPrimitive(earlier)}}"""),
            event(3, "output.message", """{"content":"The rollout passed its checks. The launch notes are ready for review."}"""),
            event(4, "run.completed", "null"),
            event(5, "output.followups", """{"content":${JsonPrimitive(followups)}}"""),
        ))
        openConversation {
            val work = By.textContains("Worked for")
            val next = By.text(suggestion)
            val workBounds = action(work).visibleBounds
            val nextBounds = action(next).visibleBounds
            ScreenshotCapture.capture("07-actions-idle.png")
            check(workBounds.height() >= 48 && nextBounds.height() >= 48) {
                "Native action bounds must be at least 48dp high. Summary $workBounds, suggestion $nextBounds"
            }
            check(workBounds.left == nextBounds.left && workBounds.right < nextBounds.right) {
                "Summary $workBounds and suggestion $nextBounds must share a leading edge"
            }
            capturePress(workBounds, "08-work-summary-ripple.png", workBounds.left + 10, workBounds.top + 12)
            check(!device.hasObject(By.text(earlier)))
            capturePress(nextBounds, "09-suggestion-ripple.png", nextBounds.left + 10, nextBounds.top + 12)
            action(work).click()
            item(By.text(earlier))
            action(next).click()
            item(By.clazz("android.widget.EditText").text(suggestion))
        }
    }

    @Test
    fun withdrawsTheThumbnailAfterTheOriginalIsDenied() = withChat { fixture ->
        fixture.install()
        openConversation {
            val image = By.desc(fixture.readyAlt)
            val before = paintedImage(image)
            fixture.readyReferenceDenied = true
            item(image).click()
            item(By.text(app.getString(ai.okou.android.R.string.artifact_access_denied)))
            item(By.desc(app.getString(ai.okou.android.R.string.back))).click()
            await {
                val placeholder = device.findObject(image)
                placeholder != null && placeholder.visibleBounds == before && !placeholder.isClickable
            }
            check(fixture.thumbnails == listOf(fixture.readyReference) && fixture.originals.isEmpty())
            ScreenshotCapture.capture("10-revoked-thumbnail.png")
        }
    }

    private fun withChat(size: String = "412x892", fontScale: String = "1.0", test: (InlineImageFixture) -> Unit) =
        withApi(size, fontScale) { test(InlineImageFixture(it)) }

    private fun withApi(size: String = "412x892", fontScale: String = "1.0", test: (ChatListApiFixture) -> Unit) {
        val originalSize = displayValue("size")
        val originalDensity = displayValue("density")
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        val originalAnimator = device.executeShellCommand("settings get global animator_duration_scale").trim()
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
                device.executeShellCommand("settings put global animator_duration_scale 1")
                test(api)
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
                    if (originalAnimator.toFloatOrNull() == null)
                        device.executeShellCommand("settings delete global animator_duration_scale")
                    else device.executeShellCommand("settings put global animator_duration_scale $originalAnimator")
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

    private fun action(label: BySelector): UiObject2 =
        checkNotNull(generateSequence(item(label)) { it.parent }.firstOrNull { it.isClickable }) {
            "No clickable action for $label"
        }

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
                pixel(bounds.right - (bounds.width() / 24).coerceAtLeast(4), bounds.centerY()) ==
                    Color.parseColor("#F9F4EF")
        }
        return item(selector).visibleBounds
    }

    private fun pixel(x: Int, y: Int): Int {
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        return try { image.getPixel(x, y) } finally { image.recycle() }
    }

    private fun capturePress(
        bounds: Rect,
        file: String = "02-image-pressed.png",
        x: Int = bounds.right - 10,
        y: Int = bounds.centerY(),
    ) {
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
            ScreenshotCapture.capture(file)
        } finally {
            inject(MotionEvent.ACTION_CANCEL)
        }
        await { pixel(x, y) == before }
    }
}
