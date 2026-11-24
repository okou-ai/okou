package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.FoldedWorkspaceSearchFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.os.LocaleList
import android.view.accessibility.AccessibilityNodeInfo
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workspaceSearchOpensOnlyTheMatchedFoldedTurn() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalSearch = app.searchService
        val originalComposer = app.composerService
        val originalPreferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val originalCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize = device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity = device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        val chats = ChatListApiFixture()
        val fixture = FoldedWorkspaceSearchFixture(chats)
        val title = "发布与访谈"
        chats.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null)
                jsonResponse("""{"events":[],"hasMore":false}""")
            else jsonResponse("""{"events":[${chatEventWire(title = title)}],"hasMore":false}""")
        }
        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        fun field() =
            checkNotNull(device.wait(Until.findObjects(By.pkg(app.packageName).clazz("android.widget.EditText")), 12_000))
                .minBy { it.visibleBounds.left }
        fun hideIme(scenario: ActivityScenario<MainActivity>) {
            scenario.onActivity { activity ->
                WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                    .hide(WindowInsetsCompat.Type.ime())
            }
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean =
                            instrumentation.uiAutomation.windows.none {
                                it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
                            }
                    },
                    10_000,
                ),
            ) { "Expected the keyboard to be hidden" }
        }
        fun assertSearchRestored() {
            assertEquals(fixture.keyword, field().text)
            get(By.pkg(app.packageName).selected(true).hasChild(By.text(label(R.string.chat_search_messages))))
        }
        fun states(node: AccessibilityNodeInfo): Sequence<String> = sequence {
            node.stateDescription?.let { yield(it.toString()) }
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { yieldAll(states(it)) }
            }
        }
        fun awaitDisclosures(expectedExpanded: Int) {
            val automation = instrumentation.uiAutomation
            val expanded = label(R.string.conversation_replies_expanded)
            val collapsed = label(R.string.conversation_replies_collapsed)
            var actual = emptyList<String>()
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            check(automation.clearCache())
                            val root = automation.rootInActiveWindow ?: return false
                            actual = states(root).toList()
                            return actual.count { it.endsWith(expanded) } == expectedExpanded &&
                                actual.count { it.endsWith(collapsed) } == 2 - expectedExpanded
                        }
                    },
                    5_000,
                ),
            ) { "Expected $expectedExpanded expanded disclosures with two visible turns. Observed: $actual" }
        }

        try {
            app.initialPreferences =
                testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS, theme = UserPreferencesTheme.LIGHT)
            app.chatService = chats.service
            app.searchService = chats.service
            app.composerService = chats.service
            device.executeShellCommand("wm density 160")
            for (layout in listOf("phone", "wide")) {
                val wide = layout == "wide"
                device.executeShellCommand("wm size ${if (wide) "1000x800" else "412x892"}")
                auth.state.value = testAuthenticationState(user = "folded-workspace-search-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        device.awaitChatList(localized)
                        get(text(title))
                        if (wide) {
                            get(text(title)).click()
                            assertTrue(get(text(fixture.otherFinalReply)).visibleBounds.left >= 320)
                            assertFalse(device.hasObject(text(fixture.hit)))
                            assertFalse(device.hasObject(text(fixture.otherEarlierReply)))
                            awaitDisclosures(expectedExpanded = 0)
                        }
                        get(control(R.string.chat_search_workspace)).click()
                        get(text(label(R.string.chat_search_messages))).click()
                        field().click()
                        field().text = fixture.keyword
                        hideIme(scenario)
                        get(text(fixture.otherHit))
                        val match = get(text(fixture.hit))
                        assertSearchRestored()
                        ScreenshotCapture.capture("folded-search-$layout.png")
                        match.click()

                        if (wide) device.awaitChatList(localized)
                        device.awaitKeyboardFocus(text(fixture.hit))
                        val reply = get(text(fixture.hit)).visibleBounds
                        get(text(fixture.otherFinalReply))
                        assertFalse(device.hasObject(text(fixture.otherEarlierReply)))
                        if (wide) {
                            assertTrue(reply.left >= 320)
                        }
                        ScreenshotCapture.capture("folded-hit-$layout.png")
                        awaitDisclosures(expectedExpanded = 1)
                        if (!wide) {
                            assertTrue(device.pressBack())
                            assertSearchRestored()
                            device.awaitKeyboardFocus(text(fixture.hit))
                            ScreenshotCapture.capture("folded-return-phone.png")
                        }
                    } catch (error: Throwable) {
                        runCatching {
                            TestStorage().openOutputFile("folded-search-window.xml")
                                .use(device::dumpWindowHierarchy)
                            ScreenshotCapture.capture("folded-search-failure.png")
                        }.exceptionOrNull()?.let(error::addSuppressed)
                        throw error
                    }
                }
            }
        } finally {
            app.chatService = originalChats
            app.searchService = originalSearch
            app.composerService = originalComposer
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            chats.close()
            originalCache.restore()
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
