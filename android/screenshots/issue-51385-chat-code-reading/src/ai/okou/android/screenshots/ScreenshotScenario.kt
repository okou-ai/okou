package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.HISTORY_RUN
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.api.generated.SessionOutputDelta
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.chat.RunOutputSignal
import ai.okou.android.historyEventWire
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Rect
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.abs
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val first = listOf(
        "data class Review(val title: String, val ready: Boolean)",
        "",
        "fun reviewPackage(): Review {",
        "\tval title = \"Android release\"",
        "\tval ready = true",
        "\t// Verify the build and screenshots.",
        "\treturn Review(title, ready)",
        "}",
        "",
        "val check = reviewPackage()",
        "val source = \"Conversation\"",
        "val verifiedBuilds = 3",
    )
    private val rest = listOf(
        "",
        "val checklist = listOf(",
        "\t\"Open the most recent chat\",",
        "\t\"Read the code preview\",",
        "\t\"Open the complete Kotlin source\",",
        "\t\"Keep the reading position on return\",",
        ")",
        "",
        "println(check.title)",
        "println(check.ready)",
    )
    private val source = first.plus(rest).joinToString("\n", postfix = "\n")
    private val opening = "```kotlin\n"
    private val closing = "```"

    @Test
    fun phoneShowsTheLivePreviewAndCompleteSource() =
        withChat(412, 892, "1.0", streaming = true) { _, realtime ->
            val target = waitForTarget(realtime)
            val at = Instant.now().toString()
            fun delta(index: Long, value: String) {
                realtime.output(
                    RunOutputSignal.Delta(
                        SessionOutputDelta(CHAT_PERSONAL, HISTORY_RUN, ReplyId, "code-reading", at, index, value),
                    ),
                )
            }
            delta(0, "下面是发布核对代码。\n\n$opening" + first.joinToString("\n", postfix = "\n"))
            item(By.textContains("val verifiedBuilds = 3"))
            check(!device.hasObject(By.text("查看完整代码")))
            delta(1, rest.joinToString("\n", postfix = "\n") + closing)
            val label = item(By.text("Kotlin")).visibleBounds
            val copy = action(By.desc("复制代码")).visibleBounds
            checkTarget(copy)
            check(label.left < copy.left && abs(label.centerY() - copy.centerY()) <= 2)
            val view = item(By.text("查看完整代码"))
            item(By.text("显示 12 / 22 行"))
            check(!device.hasObject(By.textContains("println(check.ready)")))
            ScreenshotCapture.capture("01-phone-preview.png")

            view.click()
            checkReader(wide = false)
            check(realtime.target.value == target) { "Opening complete source replaced the live subscription." }
            item(By.textContains("println(check.ready)"))
            ScreenshotCapture.capture("02-phone-full-code.png")
            check(device.pressBack())
            item(By.text("查看完整代码"))
        }

    @Test
    fun wideWindowKeepsTheWorkspaceListUntilExpanding() =
        withChat(1180, 820, "1.0", theme = UserPreferencesTheme.DARK) { activity, _ ->
            item(By.text("查看完整代码")).click()
            val pane = checkReader(wide = true)
            check(pane.left >= 322) { "Reader back target did not stay in the detail pane: $pane" }
            ScreenshotCapture.capture("03-wide-code-pane.png")
            action(By.desc("展开代码查看器")).click()
            val expanded = checkReader(wide = false)
            check(expanded.left < 32 && expanded.left < pane.left)
            activity.recreate()
            check(checkReader(wide = false).left == expanded.left)
            action(By.desc("收起代码查看器")).click()
            check(checkReader(wide = true).left == pane.left)
            action(By.desc("返回")).click()
            item(By.text("查看完整代码"))
        }

    @Test
    fun shortWindowKeepsTheBackAndCopyTargetsAtLargeText() =
        withChat(1000, 440, "2.0") { _, _ ->
            item(By.text("查看完整代码")).click()
            val back = checkReader(wide = false)
            check(back.left < 32)
            check(!device.hasObject(By.desc("展开代码查看器")))
            ScreenshotCapture.capture("04-short-large-text-code.png")
            check(device.pressBack())
            item(By.text("查看完整代码"))
        }

    private fun checkReader(wide: Boolean): Rect {
        val title = item(By.text("完整代码")).visibleBounds
        val back = action(By.desc("返回")).visibleBounds
        val copy = action(By.desc("复制代码")).visibleBounds
        checkTarget(back)
        checkTarget(copy)
        check(back.right <= title.left && title.right <= copy.left)
        if (wide) action(By.desc("展开代码查看器"))
        item(By.textContains("println(check.ready)"))
        return back
    }

    private fun checkTarget(bounds: Rect) {
        check(abs(bounds.width() - 48) <= 1 && abs(bounds.height() - 48) <= 1) {
            "Expected a 48dp action at mdpi, got $bounds."
        }
    }

    private fun item(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }

    private fun action(selector: BySelector): UiObject2 =
        checkNotNull(generateSequence(item(selector)) { it.parent }.firstOrNull { it.isClickable }) {
            "No clickable ancestor for $selector"
        }

    private fun waitForTarget(realtime: TestRealtimeService) =
        checkNotNull(device.wait(object : Condition<UiDevice, ai.okou.android.chat.RunOutputTarget?> {
            override fun apply(device: UiDevice) = realtime.target.value
        }, 10_000))

    private fun withChat(
        width: Int,
        height: Int,
        fontScale: String,
        streaming: Boolean = false,
        theme: UserPreferencesTheme = UserPreferencesTheme.LIGHT,
        accept: (ActivityScenario<MainActivity>, TestRealtimeService) -> Unit,
    ) {
        val priorService = app.chatService
        val priorRealtime = app.realtimeService
        val priorPreferences = app.snapshotApiPreferences()
        val priorLocales = AppCompatDelegate.getApplicationLocales()
        val auth = app.authentication as TestAuthentication
        val priorAuthentication = auth.state.value
        val priorSize = overrideValue("size")
        val priorDensity = overrideValue("density")
        val priorFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val realtime = TestRealtimeService()
        ChatListApiFixture().use { fixture ->
            var failure: Throwable? = null
            try {
                device.executeShellCommand("wm size ${width}x$height")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale $fontScale")
                app.chatService = fixture.service
                app.realtimeService = realtime
                val user = "code-reading-${UUID.randomUUID()}"
                val preferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = theme,
                )
                app.restoreApiPreferences(priorPreferences + (Triple(BuildConfig.API_ORIGIN, user, "org-a") to preferences))
                auth.state.value = testAuthenticationState(user = user)
                val input = historyEventWire(
                    "51385000-0000-4000-8000-000000000001",
                    1,
                    type = "input.prompt",
                    payload = """{"userMessage":{"version":1,"parts":[{"type":"text","text":"给我一段发布核对代码。"}]}}""",
                    createdAt = Instant.now().toString(),
                )
                fixture.setHistoryEvents(
                    CHAT_PERSONAL,
                    if (streaming) listOf(input) else listOf(
                        input,
                        historyEventWire(
                            ReplyId, 2,
                            payload = """{"content":${JsonPrimitive("下面是发布核对代码。\n\n$opening$source$closing")}}""",
                        ),
                        historyEventWire(
                            "51385000-0000-4000-8000-000000000003", 3, type = "run.completed", payload = "null",
                        ),
                    ),
                )
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean =
                            device.displayWidth == width &&
                                device.displayHeight == height &&
                                app.resources.configuration.densityDpi == 160 &&
                                abs(app.resources.configuration.fontScale - fontScale.toFloat()) < 0.01f
                    }, 12_000) == true)
                    device.awaitChatList(app)
                    item(By.text("Personal chat")).click()
                    try {
                        accept(activity, realtime)
                    } catch (error: Throwable) {
                        runCatching { ScreenshotCapture.capture("diagnostic-$width-$height.png") }
                            .exceptionOrNull()?.let(error::addSuppressed)
                        throw error
                    }
                }
            } catch (error: Throwable) {
                failure = error
                throw error
            } finally {
                val restorations = listOf(
                    runCatching { auth.state.value = priorAuthentication },
                    runCatching {
                        app.chatService = priorService
                        app.realtimeService = priorRealtime
                        app.restoreApiPreferences(priorPreferences)
                    },
                    runCatching { instrumentation.runOnMainSync { AppCompatDelegate.setApplicationLocales(priorLocales) } },
                    runCatching { device.executeShellCommand("wm size ${priorSize ?: "reset"}") },
                    runCatching { device.executeShellCommand("wm density ${priorDensity ?: "reset"}") },
                    runCatching {
                        device.executeShellCommand(
                            if (priorFontScale == "null") "settings delete system font_scale"
                            else "settings put system font_scale $priorFontScale",
                        )
                    },
                    runCatching { cache.restore() },
                ).mapNotNull { it.exceptionOrNull() }
                if (failure == null && restorations.isNotEmpty()) throw restorations.first()
                restorations.forEach { failure?.addSuppressed(it) }
            }
        }
    }

    private fun overrideValue(setting: String): String? =
        device.executeShellCommand("wm $setting")
            .lineSequence().firstOrNull { it.startsWith("Override ") }
            ?.substringAfter(": ")?.trim()

    private companion object {
        const val ReplyId = "51385000-0000-4000-8000-000000000002"
    }
}
