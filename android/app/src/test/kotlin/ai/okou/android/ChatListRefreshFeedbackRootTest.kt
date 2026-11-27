package ai.okou.android

import ai.okou.android.chat.ChatReadPhase
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ChatListRefreshFeedbackRootTest : ChatListRootTestFixture() {
    @Test
    fun aTerminalIndicatorFailureNotifiesWhenTheFirstListArrives() {
        val app = compose.activity.application as ChatListApplication
        val finishList = CountDownLatch(1)
        val listEvents = app.fixture.events
        app.fixture.events = { request ->
            check(finishList.await(10, TimeUnit.SECONDS))
            listEvents(request)
        }
        app.fixture.indicators = { MockResponse().setResponseCode(400) }
        val message = app.getString(R.string.chat_refresh_failed)
        val snackbar = hasText(message) and hasAnyAncestor(hasTestTag("chat_list_feedback"))

        try {
            app.responseGate.countDown()
            compose.waitUntil(10_000) { currentList()?.indicatorsPhase == ChatReadPhase.Failed }
            assertNull(currentList()?.confirmedAt)
            compose.onNodeWithText(message).assertDoesNotExist()

            finishList.countDown()
            awaitListAndNames()
            compose.onNodeWithText("Personal chat").assertIsDisplayed()
            compose.waitUntilExactlyOneExists(snackbar, 5_000)
            compose.onNode(snackbar).assertIsDisplayed()
        } finally {
            finishList.countDown()
        }
    }

    @Test
    fun aLateProjectFailureDoesNotNotifyAfterReturningToTheList() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val started = CountDownLatch(1)
        val finishProject = CountDownLatch(1)
        app.fixture.projectEvents = {
            started.countDown()
            check(finishProject.await(10, TimeUnit.SECONDS))
            MockResponse().setResponseCode(400)
        }
        val message = app.getString(R.string.chat_metadata_unavailable)
        val snackbar = hasText(message) and hasAnyAncestor(hasTestTag("chat_list_feedback"))

        try {
            refreshWorkspaceChats()
            compose.waitUntil(10_000) { started.count == 0L }
            compose.onNodeWithText("Personal chat").performClick()
            compose.onNodeWithTag("conversation").assertIsDisplayed()
            compose.onNodeWithTag("chat_list").assertDoesNotExist()
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithText("Personal chat").assertIsDisplayed()

            finishProject.countDown()
            compose.waitUntil(10_000) { currentList()?.projectsPhase == ChatReadPhase.Failed }
            compose.onNodeWithText(message).assertDoesNotExist()

            refreshWorkspaceChats()
            compose.waitUntilExactlyOneExists(snackbar, 5_000)
            compose.onNode(snackbar).assertIsDisplayed()
        } finally {
            finishProject.countDown()
        }
    }
}
