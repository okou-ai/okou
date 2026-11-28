package ai.okou.android

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w1000dp-h800dp", application = ChatListApplication::class)
internal class ChatListProjectCreationRootTest : ChatListRootTestFixture() {
    @Test
    fun confirmedCreationRevealsTheExpandedProjectBeforeRefreshWithoutChangingWideDetail() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val releaseWrite = CountDownLatch(1)
        val releaseRefresh = CountDownLatch(1)
        val projectId = AtomicReference<String>()
        app.fixture.commandResponse = { request ->
            if (request.method == "POST" && request.path == "/api/projects") {
                val body = request.jsonCommandBody()
                val id = body.getValue("id").jsonPrimitive.content
                check(id == body.getValue("eventId").jsonPrimitive.content)
                check(body.getValue("name").jsonPrimitive.content == "Field notes")
                projectId.set(id)
                releaseWrite.await()
                projectReceipt(id).setResponseCode(201)
            } else null
        }
        app.fixture.projectEvents = {
            if (projectId.get() != null) releaseRefresh.await()
            jsonResponse("""{"events":[],"hasMore":false}""")
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()
            compose.waitUntilExactlyOneExists(hasText("Native history reply"), 10_000)
            val filter = compose.onNodeWithContentDescription("Filter")
            filter.performClick()
            compose.onNodeWithText("Archived").performClick()
            compose.onNodeWithTag("chat_filter_heading").assertTextContains("Archived")
            val name = openCreate()
            name.assertIsFocused().performTextReplacement("  Field notes  ")
            val action = confirm()
            val actionBounds = action.getUnclippedBoundsInRoot()
            val fieldBounds = name.getUnclippedBoundsInRoot()
            action.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            action.performClick()
            compose.waitUntil(10_000) { projectId.get() != null }
            val pending = compose.onNodeWithText("Creating…")
            pending.assertIsDisplayed().assertIsNotEnabled().assertIsFocused()
            assertEquals(actionBounds, pending.getUnclippedBoundsInRoot())
            assertEquals(fieldBounds, name.getUnclippedBoundsInRoot())
            compose.onNodeWithText("Cancel").assertIsNotEnabled()
            compose.onNode(createdProject()).assertDoesNotExist()

            releaseWrite.countDown()
            compose.waitUntilExactlyOneExists(createdProject(), 10_000)
            compose.onNode(createdProject()).assertIsDisplayed().assertIsFocused()
            compose.onNodeWithText("New chat in this Project").assertIsDisplayed()
            compose.onNodeWithTag("chat_filter_heading").assertDoesNotExist()
            compose.onNodeWithText("Native history reply").assertIsDisplayed()

            filter.performClick()
            compose.onNodeWithText("Archived").performClick()
            compose.onNodeWithTag("chat_filter_heading").assertTextContains("Archived")
            compose.onNodeWithText("Native history reply").assertIsDisplayed()
        } finally {
            releaseWrite.countDown()
            releaseRefresh.countDown()
            instrumentation.setInTouchMode(true)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun nameLengthIsValidatedOnlyOnSubmitAndRejectionKeepsTheNameEditable() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val writes = AtomicInteger()
        app.fixture.commandResponse = { request ->
            if (request.method == "POST" && request.path == "/api/projects") {
                writes.incrementAndGet()
                MockResponse().setResponseCode(400)
            } else null
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            val more = compose.onNodeWithContentDescription("More actions")
            more.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            val field = openCreate()
            val warning = "Project name must be 120 characters or fewer"
            val overlong = "a".repeat(121)
            confirm().assertIsNotEnabled()
            field.performTextReplacement(overlong)
            compose.onNodeWithText(warning).assertDoesNotExist()
            confirm().performClick()
            compose.onNodeWithText(warning).assertIsDisplayed()
            assertEquals(0, writes.get())
            field.performTextReplacement("Field notes")
            compose.onNodeWithText(warning).assertDoesNotExist()
            field.performTextReplacement(overlong)
            compose.onNodeWithText(warning).assertDoesNotExist()
            field.performTextReplacement("Field notes")
            confirm().performClick()
            val failure = "Couldn’t create the project. The name has been kept."
            compose.waitUntilExactlyOneExists(hasText(failure), 10_000)
            field.assertTextContains("Field notes").performTextReplacement("Revised")
            compose.onNodeWithText("Cancel").performClick()
            more.assertIsFocused()

            compose.onNodeWithText("Research").performSemanticsAction(SemanticsActions.OnLongClick)
            compose.onNodeWithText("Rename").performClick()
            compose.onNodeWithContentDescription("Project name").performTextReplacement(overlong)
            compose.onNodeWithText(warning).assertDoesNotExist()
            compose.onNodeWithText("Save").performClick()
            compose.onNodeWithText(warning).assertIsDisplayed()
        } finally {
            instrumentation.setInTouchMode(true)
        }
    }

    @Test
    fun aCreationDeletedBeforeItsReplySettlesWithoutChangingTheFilter() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        val releaseWrite = CountDownLatch(1)
        val projectId = AtomicReference<String>()
        val publishedEvents = AtomicReference("")
        app.fixture.commandResponse = { request ->
            if (request.method == "POST" && request.path == "/api/projects") {
                projectId.set(request.jsonCommandBody().getValue("id").jsonPrimitive.content)
                releaseWrite.await()
                MockResponse().setResponseCode(404)
            } else null
        }
        app.fixture.projectEvents = { request ->
            val events =
                publishedEvents
                    .get()
                    .takeIf {
                        request.requestUrl?.queryParameter("sinceSeqId") == "0"
                    }
                    .orEmpty()
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            val filter = compose.onNodeWithContentDescription("Filter")
            filter.performClick()
            compose.onNodeWithText("Archived").performClick()
            val more = compose.onNodeWithContentDescription("More actions")
            more.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            val name = openCreate()
            name.performTextReplacement("Field notes")
            confirm().performClick()
            compose.waitUntil(10_000) { projectId.get() != null }
            compose.onNodeWithText("Creating…").assertIsDisplayed()

            val id = checkNotNull(projectId.get())
            publishedEvents.set(
                """
                    {"id":"$id","seqId":1,"projectId":"$id","kind":"created","name":"Field notes","createdAt":"$CHAT_DATE"},
                    {"id":"00000002-0000-4000-8000-000000000000","seqId":2,"projectId":"$id","kind":"deleted","name":null,"createdAt":"$CHAT_DATE"}
                """
                    .trimIndent(),
            )
            refreshWorkspaceChats()
            compose.waitUntilDoesNotExist(hasTestTag("create_project_sheet"), 10_000)
            compose.onNodeWithTag("chat_filter_heading").assertTextContains("Archived")
            more.assertIsFocused()
            filter.performClick()
            compose.onNodeWithText("Inbox").performClick()
            compose.onNodeWithText("Field notes").assertDoesNotExist()
        } finally {
            releaseWrite.countDown()
            instrumentation.setInTouchMode(true)
        }
    }

    @Test
    fun anUnconfirmedResponseRestoresEditingAndCreateChecksTheOriginalId() {
        val app = compose.activity.application as ChatListApplication
        val id = AtomicReference<String>()
        val writes = AtomicInteger()
        val committed = AtomicBoolean(false)
        val lookups = AtomicInteger()
        val releaseReceipt = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            when {
                request.method == "POST" && request.path == "/api/projects" -> {
                    writes.incrementAndGet()
                    val project = request.jsonCommandBody().getValue("id").jsonPrimitive.content
                    id.set(project)
                    jsonResponse(
                            """{"id":"$project","name":"Field notes","createdAt":"invalid","updatedAt":"$CHAT_DATE"}""",
                        )
                        .setResponseCode(201)
                }
                request.method == "GET" && request.path == "/api/projects/${id.get()}" -> {
                    lookups.incrementAndGet()
                    if (committed.get()) {
                        check(releaseReceipt.await(10, TimeUnit.SECONDS))
                        projectReceipt(id.get())
                    } else MockResponse().setResponseCode(404)
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Research").assertIsDisplayed()
        val field = openCreate()
        field.performTextReplacement("Field notes")
        confirm().performClick()
        val failed = hasText("Couldn’t create the project. The name has been kept.")
        compose.waitUntilExactlyOneExists(failed, 10_000)
        assertEquals(1, writes.get())
        assertEquals(1, lookups.get())
        field.assertTextContains("Field notes")
        confirm().assertIsEnabled()
        field.performTextReplacement("Another draft")
        field.assertTextContains("Another draft")
        compose.onNodeWithText("Cancel").performClick()
        field.assertDoesNotExist()
        openCreate().assertTextContains("Another draft")
        field.performTextReplacement("  Field notes  ")
        committed.set(true)
        try {
            confirm().performClick()
            compose.onNodeWithText("Checking whether the project was created").assertIsDisplayed()
            compose.onNodeWithText("Checking…").assertIsNotEnabled()
            compose.onNodeWithText("Cancel").assertIsNotEnabled()
            compose.onNode(failed).assertDoesNotExist()
        } finally {
            releaseReceipt.countDown()
        }
        compose.waitUntilExactlyOneExists(createdProject(), 10_000)
        field.assertDoesNotExist()
        compose.onNodeWithText("New chat in this Project").assertIsDisplayed()
        assertEquals(1, writes.get())
        assertEquals(2, lookups.get())
    }

    @Test
    fun aLateCreationReceiptKeepsTheNewerDraftOpen() {
        val app = compose.activity.application as ChatListApplication
        val id = AtomicReference<String>()
        val publishCreation = AtomicBoolean(false)
        app.fixture.commandResponse = { request ->
            when {
                request.method == "POST" && request.path == "/api/projects" -> {
                    id.set(request.jsonCommandBody().getValue("id").jsonPrimitive.content)
                    jsonResponse("{}").setResponseCode(201)
                }
                request.method == "GET" && request.path == "/api/projects/${id.get()}" ->
                    MockResponse().setResponseCode(404)
                else -> null
            }
        }
        app.fixture.projectEvents = { request ->
            val events =
                if (
                    publishCreation.get() && request.requestUrl?.queryParameter("sinceSeqId") == "0"
                )
                    """{"id":"${id.get()}","seqId":1,"projectId":"${id.get()}","kind":"created","name":"Field notes","createdAt":"$CHAT_DATE"}"""
                else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val field = openCreate()
        field.performTextReplacement("Field notes")
        confirm().performClick()
        val failed = hasText("Couldn’t create the project. The name has been kept.")
        compose.waitUntilExactlyOneExists(failed, 10_000)
        field.performTextReplacement("Another draft")

        publishCreation.set(true)
        refreshWorkspaceChats()
        compose.waitUntil(10_000) {
            val state = currentList() ?: return@waitUntil false
            state.projectList.creation == null && state.projects.count { it.id == id.get() } == 1
        }
        field.assertTextContains("Another draft")
        confirm().assertIsEnabled()
        compose.onNode(failed).assertDoesNotExist()
    }

    private fun openCreate() =
        compose.onNodeWithContentDescription("Project name").also {
            compose.onNodeWithContentDescription("More actions").performClick()
            val create = compose.onNodeWithText("New project")
            val settings = compose.onNodeWithText("Settings")
            assertTrue(
                create.getUnclippedBoundsInRoot().top < settings.getUnclippedBoundsInRoot().top,
            )
            create.performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("create_project_sheet"), 10_000)
            val bounds = it.getUnclippedBoundsInRoot()
            assertTrue(bounds.bottom - bounds.top >= 56.dp)
        }

    private fun confirm() = compose.onNodeWithText("Create")

    private fun createdProject() =
        hasText("Field notes") and SemanticsMatcher.keyIsDefined(SemanticsActions.Collapse)

    private fun projectReceipt(id: String) =
        jsonResponse(
            """{"id":"$id","name":"Field notes","sortOrder":"a1","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}""",
        )
}
