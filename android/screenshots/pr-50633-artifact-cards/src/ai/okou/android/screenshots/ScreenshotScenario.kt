package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Rect
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.SearchCondition
import androidx.test.uiautomator.Searchable
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val intro = "发布摘要已准备好。"
    private val media = "用于发布公告、首页和社区帖子的头像与横幅素材预览"
    private val previewTitle = "summary.md"

    @Test
    fun captureConversationArtifactCardsAndPreview() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val oldPreferences = app.initialPreferences
        val oldApiPreferences = app.snapshotApiPreferences()
        val oldConnectivity = app.connectivity.value
        val oldSize = device.executeShellCommand("wm size")
        val oldDensity = device.executeShellCommand("wm density")
        val oldFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val database = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            val artifacts = ArtifactApiFixture(api, chinese = true)
            artifacts.install()
            installHistory(api, artifacts)
            try {
                auth.state.value =
                    testAuthenticationState(user = "artifact-cards-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                    timezone = "Asia/Shanghai",
                )
                app.connectivity.value = true
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                open(412, 892, artifacts) { capturePhone(artifacts) }
                open(1180, 820, artifacts) { captureWide(artifacts) }
                assertTrue(artifacts.catalogScopes.isEmpty())
            } finally {
                instrumentation.resetInTouchMode()
                restoreDisplay("size", oldSize)
                restoreDisplay("density", oldDensity)
                if (oldFontScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else device.executeShellCommand("settings put system font_scale $oldFontScale")
                auth.state.value = oldAuth
                app.chatService = oldService
                app.initialPreferences = oldPreferences
                app.restoreApiPreferences(oldApiPreferences)
                app.connectivity.value = oldConnectivity
                database.restore()
            }
        }
    }

    private fun installHistory(api: ChatListApiFixture, artifacts: ArtifactApiFixture) {
        val earlier = "[${artifacts.site.title}](https://fixture.okou.app/)\n\n" +
            "[${artifacts.slides.title}](/artifacts/launchdeck.pptx)"
        val reply = "$intro\n\n[${artifacts.summary.title}](/artifacts/artifacts2.md)\n\n" +
            "- [${artifacts.checklist.title}](/artifacts/checklist1.md)\n" +
            "- [$media](/artifacts/thumbnail1.png)"
        val prompt = """{"userMessage":{"version":1,"parts":[{"type":"text","text":"把发布摘要和素材整理一下。"}]}}"""
        api.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        api.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            val thread = url.pathSegments[2]
            val since = url.queryParameter("sinceSeqId")?.toLong() ?: 0
            val rows = listOf(
                17L to historyEventWire("input", 17, thread, "input.prompt", prompt),
                19L to historyEventWire("earlier-output", 19, thread, payload = """{"content":${JsonPrimitive(earlier)}}"""),
                23L to historyEventWire("output", 23, thread, payload = """{"content":${JsonPrimitive(reply)}}"""),
                37L to historyEventWire(HISTORY_LAST_EVENT, 37, thread, "run.completed", "null"),
            ).filter { (sequence, _) -> sequence > since }.joinToString(",") { it.second }
            jsonResponse("""{"rows":[$rows],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37},"hasMore":false}""")
        }
    }

    private fun open(width: Int, height: Int, artifacts: ArtifactApiFixture, block: () -> Unit) {
        device.executeShellCommand("wm size ${width}x$height")
        ActivityScenario.launch(MainActivity::class.java).use { activity ->
            activity.onActivity {
                assertEquals(width, it.resources.configuration.screenWidthDp)
                assertEquals(160, it.resources.configuration.densityDpi)
                assertEquals(1f, it.resources.configuration.fontScale, 0f)
            }
            see(By.text(artifacts.sourceTitle))
            tap(bounds(By.text(artifacts.sourceTitle)))
            try {
                verifyCardLayout(artifacts, compact = width == 412)
                block()
            } catch (error: AssertionError) {
                runCatching { ScreenshotCapture.capture("diagnostic-$width.png") }
                throw error
            }
        }
    }

    private fun verifyCardLayout(artifacts: ArtifactApiFixture, compact: Boolean) {
        val summary = cardBounds(artifacts.summary.title)
        val checklist = cardBounds(artifacts.checklist.title)
        val image = cardBounds(media)
        val site = cardBounds(artifacts.site.title)
        val slides = cardBounds(artifacts.slides.title)
        val body = bounds(By.text(intro))
        assertTrue(summary.height() >= 60)
        if (compact) assertTrue(image.height() > summary.height())
        assertTrue(checklist.left > summary.left)
        assertEquals(checklist.left, image.left)
        for (card in listOf(site, slides)) {
            assertEquals(summary.left, card.left)
        }
        for (card in listOf(checklist, image, site, slides)) {
            assertEquals(summary.right, card.right)
        }
        assertEquals(body.left, summary.left)
        assertEquals(12, summary.top - body.bottom)
        assertEquals(8, checklist.top - summary.bottom)
        assertEquals(8, image.top - checklist.bottom)
        assertEquals(8, site.top - image.bottom)
        assertEquals(8, slides.top - site.bottom)
    }

    private fun capturePhone(artifacts: ArtifactApiFixture) {
        see(By.desc("聊天操作"))
        see(By.text(artifacts.sourceTitle))
        assertTrue(artifacts.requestedReferences.isEmpty())
        ScreenshotCapture.capture("cards-phone.png")
        tap(cardBounds(artifacts.summary.title))
        verifyPreview()
        assertEquals(1, artifacts.requestedReferences.size)
        ScreenshotCapture.capture("preview-phone.png")
        assertTrue("Could not inject Back", device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        cardBounds(artifacts.summary.title)
    }

    private fun captureWide(artifacts: ArtifactApiFixture) {
        val title = artifacts.summary.title
        assertEquals(1, artifacts.requestedReferences.size)
        instrumentation.setInTouchMode(false)
        focusWithTab(title)
        ScreenshotCapture.capture("cards-wide.png")
        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
        verifyPreview()
        val leftPane = bounds(By.desc("成果"))
        val preview = bounds(By.text(previewTitle))
        assertTrue(leftPane.right < preview.left)
        see(By.text(artifacts.sourceTitle))
        assertFalse(device.hasObject(By.text(artifacts.checklist.title).pkg(app.packageName)))
        assertEquals(2, artifacts.requestedReferences.size)
        ScreenshotCapture.capture("preview-wide.png")
        assertTrue("Could not inject Back", device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        awaitCardFocus(title)
    }

    private fun verifyPreview() {
        see(By.text(previewTitle))
        see(By.textContains("仅供预览"))
        see(By.textContains("帮助团队继续推进在手工作"))
        assertFalse(device.hasObject(By.text("保存文件").pkg(app.packageName)))
    }

    private fun isCardFocused(title: String): Boolean =
        device.hasObject(By.pkg(app.packageName).text(title).clickable(true).focused(true)) ||
            device.hasObject(
                By.pkg(app.packageName).clickable(true).focused(true)
                    .hasDescendant(By.text(title).pkg(app.packageName)),
            )

    private fun awaitCardFocus(title: String) {
        assertTrue("Expected keyboard focus on $title", device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean = isCardFocused(title)
        }, 15_000))
    }

    private fun focusWithTab(title: String) {
        repeat(18) {
            if (isCardFocused(title)) return
            val previous = focusName()
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
            device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean =
                    isCardFocused(title) || focusName() != previous
            }, 1_500)
        }
        awaitCardFocus(title)
    }

    private fun focusName(): String? = try {
        device.findObject(By.pkg(app.packageName).focused(true))?.let { node ->
            node.text ?: node.contentDescription ?: node.findObject(By.textContains(""))?.text
        }
    } catch (_: StaleObjectException) {
        null
    }

    private fun cardBounds(title: String): Rect =
        read(By.text(title)) { text ->
            generateSequence(text) { it.parent }.firstOrNull { it.isClickable }?.visibleBounds
        }

    private fun bounds(selector: BySelector): Rect = read(selector) { it.visibleBounds }

    private fun tap(bounds: Rect) {
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun see(selector: BySelector) {
        val present = device.wait(Until.hasObject(selector.pkg(app.packageName)), 15_000)
        if (!present) runCatching { ScreenshotCapture.capture("diagnostic.png") }
        assertTrue("Missing $selector", present)
    }

    private fun <T : Any> read(selector: BySelector, snapshot: (UiObject2) -> T?): T {
        val scoped = By.copy(selector).pkg(app.packageName)
        val result = device.wait(object : SearchCondition<T>() {
            override fun apply(searchable: Searchable): T? =
                try {
                    searchable.findObject(scoped)?.let(snapshot)
                } catch (_: StaleObjectException) {
                    null
                }
        }, 15_000)
        if (result == null) runCatching { ScreenshotCapture.capture("diagnostic.png") }
        return checkNotNull(result) { "Could not read $selector" }
    }

    private fun restoreDisplay(setting: String, previous: String) {
        val overrideValue = previous.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${overrideValue ?: "reset"}")
    }
}
