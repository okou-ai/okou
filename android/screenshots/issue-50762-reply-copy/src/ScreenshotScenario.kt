package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.InlineImageFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowInsets
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun copiesReplyFromTheNativeMenuAndPastesItInTheComposer() = withFixture { fixture ->
        val ready = "/artifacts/${fixture.readyReference}"
        val target = "https://example.com/rollout"
        fixture.install(
            latest =
                "The rollout is ready for review.\n\n![${fixture.readyAlt}]($ready)\n\n" +
                    "| Evidence | Source |\n| --- | --- |\n" +
                    "| [![Checklist]($ready)]($target) | ![${fixture.deniedAlt}](/artifacts/${fixture.deniedReference}) |",
            earlier = false,
        )
        val expected =
            "The rollout is ready for review.\n\n" +
                "${fixture.readyAlt} [${BuildConfig.WEB_ORIGIN.trimEnd('/')}$ready]\n\n" +
                "Evidence\tSource\nChecklist [$target]\t${fixture.deniedAlt}"
        val clipboard = checkNotNull(app.getSystemService(ClipboardManager::class.java))
        ActivityScenario.launch(MainActivity::class.java).use { activity ->
            device.awaitChatList(app)
            val originalClip = clipboard.primaryClip
            try {
                item(By.text("Personal chat")).click()
                await("downloaded chart and resolved table image states") {
                    val image = device.findObject(By.desc(fixture.readyAlt))?.visibleBounds
                    image != null && image.width() == 240 && image.height() == 216 &&
                        pixel(image.right - 10, image.centerY()) == Color.parseColor("#F9F4EF") &&
                        clickableAncestor(device.findObject(By.desc("Checklist"))) != null &&
                        device.hasObject(By.desc(fixture.deniedAlt)) &&
                        device.hasObject(By.text(app.getString(R.string.inline_image_unavailable))) &&
                        fixture.deniedReference in fixture.references
                }
                val overflow = By.desc(app.getString(R.string.conversation_reply_actions))
                val button = action(overflow).visibleBounds
                check(button.width() == 48 && button.height() == 48) { "Reply action bounds $button" }
                capturePress(button)
                action(overflow).click()
                val copy = By.text(app.getString(R.string.conversation_copy_reply))
                val row = action(copy).visibleBounds
                check(row.width() == 230 && row.height() == 48) { "Copy menu row bounds $row" }
                check(row.top - button.bottom in 10..12) { "Copy menu placement $row, anchor $button" }
                ScreenshotCapture.capture("02-copy-reply-menu.png")
                val references = fixture.references.toList()
                action(copy).click()
                await("exact copied reply") { clipboard.primaryClip?.getItemAt(0)?.text == expected }
                check(fixture.references.toList() == references && fixture.originals.isEmpty())

                val composer = By.clazz("android.widget.EditText").pkg(app.packageName)
                val input = item(composer).visibleBounds
                check(device.click(input.centerX(), input.top + 12))
                await("focused composer") { device.findObject(composer)?.isFocused == true }
                check(device.pressKeyCode(KeyEvent.KEYCODE_V, KeyEvent.META_CTRL_ON))
                await("pasted reply") { device.findObject(composer)?.text == expected }
                var imeVisible = false
                activity.onActivity {
                    imeVisible = it.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
                }
                if (imeVisible) {
                    check(device.pressBack())
                    await("dismissed keyboard") {
                        activity.onActivity {
                            imeVisible = it.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
                        }
                        !imeVisible
                    }
                }
                check(item(composer).text == expected)
                ScreenshotCapture.capture("03-pasted-reply.png")
            } finally {
                if (originalClip == null) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(originalClip)
            }
        }
    }

    private fun withFixture(test: (InlineImageFixture) -> Unit) {
        val size = displayOverride("size")
        val density = displayOverride("density")
        val font = device.executeShellCommand("settings get system font_scale").trim()
        val animator = device.executeShellCommand("settings get global animator_duration_scale").trim()
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChat = app.chatService
        val previousComposer = app.composerService
        val previousControls = app.controlService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            app.chatService = api.service
            app.composerService = api.service
            app.controlService = api.service
            auth.state.value = testAuthenticationState(user = "reply-copy-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                device.executeShellCommand("settings put global animator_duration_scale 1")
                test(InlineImageFixture(api))
            } finally {
                val results = listOf(
                    runCatching { cache.restore() },
                    runCatching { auth.state.value = previousAuth },
                    runCatching {
                        app.chatService = previousChat
                        app.composerService = previousComposer
                        app.controlService = previousControls
                        app.restoreApiPreferences(preferences)
                    },
                    runCatching { device.executeShellCommand("wm size $size") },
                    runCatching { device.executeShellCommand("wm density $density") },
                    runCatching { restoreSetting("system", "font_scale", font) },
                    runCatching { restoreSetting("global", "animator_duration_scale", animator) },
                )
                results.forEach { it.getOrThrow() }
            }
        }
    }

    private fun displayOverride(kind: String) =
        device.executeShellCommand("wm $kind").lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(": ")?.trim() ?: "reset"

    private fun restoreSetting(namespace: String, key: String, previous: String) {
        if (previous.toFloatOrNull() == null) device.executeShellCommand("settings delete $namespace $key")
        else device.executeShellCommand("settings put $namespace $key $previous")
    }

    private fun item(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "No node for $selector" }

    private fun action(selector: BySelector): UiObject2 =
        checkNotNull(clickableAncestor(item(selector))) {
            "No clickable action for $selector"
        }

    private fun clickableAncestor(item: UiObject2?): UiObject2? =
        generateSequence(item) { it.parent }.firstOrNull { it.isClickable }

    private fun await(expected: String, condition: () -> Boolean) {
        if (!device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice) =
                try { condition() } catch (_: StaleObjectException) { false }
        }, 12_000)) {
            val hierarchy = ByteArrayOutputStream()
            device.dumpWindowHierarchy(hierarchy)
            ScreenshotCapture.capture("diagnostic-unexpected-state.png")
            error("Timed out waiting for $expected. ${hierarchy.toString(Charsets.UTF_8.name())}")
        }
    }

    private fun pixel(x: Int, y: Int): Int {
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        return try { image.getPixel(x, y) } finally { image.recycle() }
    }

    private fun capturePress(bounds: Rect) {
        val x = bounds.centerX().toFloat()
        val y = (bounds.top + 10).toFloat()
        val inner = pixel(bounds.left + 6, bounds.top + 6)
        val outer = pixel(bounds.left + 2, bounds.top + 2)
        val time = SystemClock.uptimeMillis()
        fun inject(action: Int) {
            val event = MotionEvent.obtain(time, SystemClock.uptimeMillis(), action, x, y, 0)
            try {
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                check(instrumentation.uiAutomation.injectInputEvent(event, true))
            } finally {
                event.recycle()
            }
        }
        inject(MotionEvent.ACTION_DOWN)
        try {
            await("ripple inside the 12dp corner") { pixel(bounds.left + 6, bounds.top + 6) != inner }
            check(pixel(bounds.left + 2, bounds.top + 2) == outer) { "Ripple escaped the rounded corner" }
            ScreenshotCapture.capture("01-reply-action-pressed.png")
        } finally {
            inject(MotionEvent.ACTION_CANCEL)
        }
        await("resting reply action") { pixel(bounds.left + 6, bounds.top + 6) == inner }
    }
}
