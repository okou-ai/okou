package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.FoldedWorkspaceSearchFixture
import ai.okou.android.HISTORY_RUN
import ai.okou.android.InlineImageFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.os.LocaleList
import android.view.accessibility.AccessibilityWindowInfo
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
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
    @Test
    fun workspaceSearchOpensTheMatchedBodyBlock() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalSearch = app.searchService
        val originalComposer = app.composerService
        val originalWorkflows = app.workflows
        val originalPreferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize =
            device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity =
            device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        val showIme =
            device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val animationScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )

        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObjects(selector), 12_000)) {
                    "Missing workspace search element: $selector"
                }
                .minBy { it.visibleBounds.left }
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        fun editor() = get(By.pkg(app.packageName).clazz("android.widget.EditText"))
        fun waitForIme(visible: Boolean) {
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean =
                            instrumentation.uiAutomation.windows.any {
                                it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
                            } == visible
                    },
                    10_000,
                ),
            ) {
                "Expected keyboard visibility: $visible"
            }
        }
        fun restoreSetting(namespace: String, name: String, value: String) {
            if (value.toFloatOrNull() == null) {
                device.executeShellCommand("settings delete $namespace $name")
            } else {
                device.executeShellCommand("settings put $namespace $name $value")
            }
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            device.executeShellCommand("settings put global animator_duration_scale 0")
            for (layout in listOf("phone", "wide", "image", "list", "table")) {
                val imageCase = layout == "image"
                val listCase = layout == "list"
                val tableCase = layout == "table"
                val wide = layout == "wide" || listCase || imageCase
                device.executeShellCommand("wm size ${if (wide) "1000x800" else "412x892"}")
                auth.state.value =
                    testAuthenticationState(user = "search-capture-${UUID.randomUUID()}")
                app.initialPreferences =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme =
                                if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT,
                        )

                ChatListApiFixture().use { api ->
                    val caption = "发布排期图"
                    val artifacts =
                        ArtifactApiFixture(api, chinese = true).apply {
                            install()
                        }
                    val fixture =
                        if (imageCase || listCase || tableCase) null
                        else FoldedWorkspaceSearchFixture(api)
                    val resultText =
                        when {
                            imageCase -> caption
                            listCase -> "核对最终确认人"
                            tableCase -> "陈岚负责最终确认"
                            else -> checkNotNull(fixture).hit
                        }
                    val keyword =
                        when {
                            imageCase -> "排期图"
                            listCase || tableCase -> "最终确认"
                            else -> checkNotNull(fixture).keyword
                        }
                    val inlineImages = if (imageCase) InlineImageFixture(api) else null
                    val imageLead = "发布前的各项检查均已通过。"
                    val listNeighbor = "检查发布素材"
                    val firstHeader = "项目"
                    val body =
                        when {
                            inlineImages != null ->
                                "$imageLead\n\n![$caption](/artifacts/${inlineImages.readyReference})\n\n所有时间以北京时间为准。"
                            listCase ->
                                "发布准备清单\n\n1. 复核上线安排\n   - $listNeighbor\n   - $resultText\n2. 通知项目组"
                            tableCase ->
                                "| $firstHeader | 构建 | 测试 | 素材 | 负责人 |\n" +
                                    "| --- | --- | --- | --- | --- |\n" +
                                    "| 正式发布 | 完成 | 通过 | 已审核 | $resultText |"
                            else -> null
                        }
                    if (body != null) {
                        val start = body.indexOf(keyword)
                        require(start >= 0)
                        if (inlineImages != null)
                            inlineImages.install(latest = body, earlier = false)
                        else api.historyReply = body
                        val sequence = if (inlineImages != null) 4 else 23
                        api.searchMessages = { request ->
                            if (request.requestUrl?.queryParameter("keyword") == keyword)
                                jsonResponse(
                                    """
                                    {"results":[{"chatThreadId":"$CHAT_PERSONAL",
                                      "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                                        "content":${JsonPrimitive(body)},"createdAt":"$CHAT_DATE","seqId":$sequence,"runId":"$HISTORY_RUN"},
                                      "matchedRanges":[{"start":$start,"end":${start + keyword.length}}]}]}
                                    """
                                        .trimIndent(),
                                )
                            else jsonResponse("""{"results":[]}""")
                        }
                    }
                    app.chatService = api.service
                    app.searchService = api.service
                    app.composerService = api.service
                    app.workflows = api.service

                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        try {
                            val thread = text(artifacts.sourceTitle)
                            val image = By.pkg(app.packageName).descContains(caption)
                            if ((wide && !listCase) || tableCase) {
                                thread.click()
                                when {
                                    imageCase -> {
                                        text(imageLead)
                                        get(image)
                                    }
                                    tableCase -> {
                                        text(firstHeader)
                                        assertFalse(device.hasObject(By.text(resultText)))
                                        device.pressBack()
                                        text(artifacts.sourceTitle)
                                    }
                                    else -> {
                                        val folded = checkNotNull(fixture)
                                        text(folded.otherFinalReply)
                                        assertFalse(
                                            device.hasObject(By.text(folded.leadingParagraph)),
                                        )
                                        assertFalse(
                                            device.hasObject(By.text(folded.otherEarlierReply)),
                                        )
                                    }
                                }
                            }

                            get(control(R.string.chat_search_workspace)).click()
                            waitForIme(true)
                            val tab =
                                By.pkg(app.packageName).text(label(R.string.chat_search_messages))
                            get(tab).click()
                            editor().text = keyword
                            scenario.onActivity { activity ->
                                WindowCompat.getInsetsController(
                                        activity.window,
                                        activity.window.decorView,
                                    )
                                    .hide(WindowInsetsCompat.Type.ime())
                            }
                            waitForIme(false)
                            val result = By.pkg(app.packageName).textContains(resultText)
                            val searchRow = get(result)
                            val searchBounds = searchRow.visibleBounds
                            assertEquals(keyword, editor().text)
                            assertEquals(48, editor().visibleBounds.height())
                            if (layout == "phone")
                                ScreenshotCapture.capture("message-search-phone.png")

                            searchRow.click()
                            val destination =
                                if (imageCase) image else By.pkg(app.packageName).text(resultText)
                            device.awaitKeyboardFocus(By.copy(destination))
                            if (tableCase) {
                                val focus = By.copy(destination).focused(true)
                                val focusedParent = By.focused(true).hasChild(By.copy(destination))
                                check(
                                    device.wait(
                                        object : Condition<UiDevice, Boolean> {
                                            override fun apply(device: UiDevice): Boolean {
                                                val bounds =
                                                    (device.findObject(focus)
                                                            ?: device.findObject(focusedParent))
                                                        ?.visibleBounds
                                                return bounds != null &&
                                                    bounds.width() == 112 &&
                                                    bounds.right <= device.displayWidth - 24
                                            }
                                        },
                                        5_000,
                                    ),
                                ) {
                                    "The entire matched cell must enter the horizontal viewport"
                                }
                            }
                            val imageName =
                                when {
                                    imageCase -> "message-image-wide.png"
                                    listCase -> "message-list-wide.png"
                                    tableCase -> "message-table-phone.png"
                                    else -> "message-target-$layout.png"
                                }
                            ScreenshotCapture.capture(imageName)
                            if (listCase) text(listNeighbor)
                            val targetBounds = get(destination).visibleBounds
                            if (imageCase) {
                                assertEquals(240, targetBounds.width())
                                assertEquals(216, targetBounds.height())
                                val reads = checkNotNull(inlineImages)
                                TestStorage().openOutputFile("matched-image-fixture.txt").use {
                                    it.write(
                                        "references=${reads.references}\nthumbnails=${reads.thumbnails}\n"
                                            .encodeToByteArray(),
                                    )
                                }
                            }
                            if (wide) {
                                val listBounds = text(artifacts.sourceTitle).visibleBounds
                                assertTrue(targetBounds.left > listBounds.right)
                                assertFalse(
                                    device.hasObject(
                                        By.clazz("android.widget.EditText").text(keyword),
                                    ),
                                )
                            }
                            if (fixture != null) {
                                assertTrue(
                                    text(fixture.leadingParagraph).visibleBounds.bottom <
                                        targetBounds.top,
                                )
                                assertFalse(device.hasObject(By.text(fixture.otherEarlierReply)))
                            }
                            if (layout == "phone") {
                                device.pressBack()
                                assertEquals(keyword, editor().text)
                                device.awaitKeyboardFocus(By.copy(result))
                                assertEquals(searchBounds, get(result).visibleBounds)
                                val selectedLabel = By.copy(tab).selected(true)
                                val selectedTab =
                                    By.pkg(app.packageName).selected(true).hasChild(By.copy(tab))
                                assertTrue(
                                    device.hasObject(selectedLabel) ||
                                        device.hasObject(selectedTab),
                                )
                            }
                        } catch (error: Throwable) {
                            runCatching {
                                    TestStorage()
                                        .openOutputFile("search-matched-block-$layout-window.xml")
                                        .use(device::dumpWindowHierarchy)
                                }
                                .exceptionOrNull()
                                ?.let(error::addSuppressed)
                            throw error
                        }
                    }
                }
            }
        } finally {
            app.chatService = originalChats
            app.searchService = originalSearch
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            cache.restore()
            restoreSetting("system", "font_scale", fontScale)
            restoreSetting("secure", "show_ime_with_hard_keyboard", showIme)
            restoreSetting("global", "animator_duration_scale", animationScale)
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
