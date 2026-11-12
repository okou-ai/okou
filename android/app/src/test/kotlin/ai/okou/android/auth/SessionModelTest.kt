package ai.okou.android.auth

import ai.okou.android.TestAuthentication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testBootstrap
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionModelTest {
    private class Resource(val identity: WorkspaceIdentity, val tokens: WorkspaceTokenProvider) :
        WorkspaceSession {
        var closed = false
        var load: suspend () -> WorkspaceBootstrap = { testBootstrap(identity.workspaceId) }
        var update: suspend () -> Unit = {}

        override suspend fun bootstrap() = load()

        override suspend fun preferences() = testBootstrap(identity.workspaceId).preferences

        override suspend fun updatePreferences(update: UpdatePreferencesRequest) =
            preferences().also { this.update() }

        override fun close() {
            closed = true
        }
    }

    private fun check(
        auth: TestAuthentication = TestAuthentication(),
        configure: (Resource) -> Unit = {},
        block: suspend TestScope.(SessionModel, MutableList<Resource>) -> Unit,
    ) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val resources = mutableListOf<Resource>()
        try {
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            SessionModel(
                                auth,
                                WorkspaceSessionFactory { identity, tokens ->
                                    Resource(identity, tokens).also {
                                        configure(it)
                                        resources += it
                                    }
                                },
                                "https://api.okou.ai/",
                            )
                        }
                    },
                )[SessionModel::class.java]
            block(model, resources)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun pendingAuthenticationAndSignedOutNeverOpenWorkspaceResources() {
        val auth = TestAuthentication(AuthenticationState())
        check(auth) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Restoring, model.uiState.value.stage)
            assertTrue(resources.isEmpty())
            auth.state.value = AuthenticationState(initialized = true)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
            assertTrue(resources.isEmpty())
        }
    }

    @Test
    fun bootstrapGatesAccessAndTokenRenewalKeepsThePresentationOwner() {
        val auth = TestAuthentication()
        val gate = CompletableDeferred<Unit>()
        check(
            auth,
            configure = { resource ->
                resource.load = {
                    gate.await()
                    testBootstrap()
                }
            },
        ) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertNull(model.uiState.value.ready)
            gate.complete(Unit)
            runCurrent()
            val ready = requireNotNull(model.uiState.value.ready)
            assertEquals("org-a", ready.identity.workspaceId)
            assertEquals("test-token", resources.single().tokens.token())
            auth.tokenAction = { "renewed-token" }
            assertEquals("renewed-token", resources.single().tokens.token())
            runCurrent()
            assertSame(ready, model.uiState.value.ready)
            assertFalse(resources.single().closed)
        }
    }

    @Test
    fun accountReplacementRejectsEvenNonCooperativeLateBootstrap() {
        val old = CompletableDeferred<Unit>()
        val auth = TestAuthentication()
        check(
            auth,
            configure = { resource ->
                if (resource.identity.userId == "user-a")
                    resource.load = {
                        withContext(NonCancellable) { old.await() }
                        testBootstrap()
                    }
            },
        ) { model, resources ->
            runCurrent()
            auth.state.value = testAuthenticationState("user-b", "session-b", "org-b")
            runCurrent()
            assertTrue(resources.first().closed)
            assertEquals("user-b", requireNotNull(model.uiState.value.ready).identity.userId)
            old.complete(Unit)
            runCurrent()
            assertEquals("org-b", requireNotNull(model.uiState.value.ready).identity.workspaceId)
        }
    }

    @Test
    fun lateTokenCannotEscapeAReplacedWorkspaceAndOldDraftIsDiscarded() {
        val auth = TestAuthentication()
        val token = CompletableDeferred<String>()
        check(auth) { model, resources ->
            runCurrent()
            val original = requireNotNull(model.uiState.value.ready)
            original.home.editDraft(androidx.compose.ui.text.input.TextFieldValue("Private A"))
            auth.tokenAction = { withContext(NonCancellable) { token.await() } }
            val request = async { runCatching { resources.first().tokens.token() } }
            runCurrent()
            model.chooseWorkspace("not-a-membership", model.uiState.value.generation)
            assertSame(original, model.uiState.value.ready)
            model.chooseWorkspace("org-b", model.uiState.value.generation)
            runCurrent()
            assertTrue(resources.first().closed)
            val next = requireNotNull(model.uiState.value.ready)
            assertNotSame(original.home, next.home)
            assertEquals("", next.home.draft.text)
            token.complete("old-token")
            runCurrent()
            assertTrue(request.await().exceptionOrNull() is CancellationException)
        }
    }

    @Test
    fun additionalAuthenticationOrRevokedMembershipRetiresAccess() {
        val auth = TestAuthentication()
        check(auth) { model, resources ->
            runCurrent()
            auth.state.value = auth.state.value.copy(complete = false)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
            assertNull(model.uiState.value.ready)
            assertTrue(resources.single().closed)
            auth.available = emptyList()
            auth.state.value = auth.state.value.copy(complete = true)
            runCurrent()
            assertEquals(SessionStage.ChooseWorkspace, model.uiState.value.stage)
            assertTrue(model.uiState.value.memberships.isEmpty())
            assertEquals(1, resources.size)
        }
    }

    @Test
    fun membershipRevocationWithoutAnIdentityChangeRechecksAndClosesAccess() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", emptyList()))
                    )
            )
        check(auth) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            auth.available = emptyList()
            auth.state.value = auth.state.value.copy(membershipAccess = emptyList())
            runCurrent()
            assertTrue(resources.single().closed)
            assertEquals(SessionStage.ChooseWorkspace, model.uiState.value.stage)
            assertNull(model.uiState.value.ready)
        }
    }

    @Test
    fun oldRenderedActionsCannotSwitchOrSignOutAReplacementAccount() {
        val auth = TestAuthentication()
        check(auth) { model, resources ->
            runCurrent()
            val original = model.uiState.value
            auth.state.value = testAuthenticationState("user-b", "session-b", "org-b")
            original.ready?.preferences?.selectColorTheme(UserPreferencesColorTheme.COTTON_SKY)
            // SDK state may advance before the ViewModel or Compose consumes the new snapshot.
            model.chooseWorkspace("org-a", original.generation)
            model.signOut(original.generation)
            model.retry(original.generation)
            assertSame(original, model.uiState.value)
            runCurrent()
            val replacement = model.uiState.value
            assertEquals("user-b", requireNotNull(replacement.ready).identity.userId)
            model.chooseWorkspace("org-a", original.generation)
            model.signOut(original.generation)
            model.retry(original.generation)
            runCurrent()
            assertSame(replacement, model.uiState.value)
            assertFalse(resources.last().closed)
        }
    }

    @Test
    fun postBootstrapAuthorizationAndUpgradeErrorsRetireTheWorkspace() {
        for ((failure, stage) in
            listOf(
                ApiFailure.Unauthenticated() to SessionStage.AccessRemoved,
                ApiFailure.UpdateRequired(RequiredUpdate("0.3.0")) to SessionStage.UpdateRequired,
            )) {
            check(configure = { resource -> resource.update = { throw failure } }) {
                model,
                resources ->
                runCurrent()
                val ready = requireNotNull(model.uiState.value.ready)
                ready.preferences.selectColorTheme(UserPreferencesColorTheme.BLUE_HORIZON)
                runCurrent()
                assertEquals(stage, model.uiState.value.stage)
                assertNull(model.uiState.value.ready)
                assertTrue(resources.single().closed)
            }
        }
    }

    @Test
    fun failedBootstrapCanRetryButSignOutRetiresBeforeTheProviderResponds() {
        val auth = TestAuthentication()
        val signOut = CompletableDeferred<Unit>()
        var fail = true
        check(
            auth,
            configure = { resource ->
                resource.load = {
                    if (fail) error("offline")
                    testBootstrap(resource.identity.workspaceId)
                }
            },
        ) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Unavailable, model.uiState.value.stage)
            assertTrue(resources.first().closed)
            fail = false
            model.retry(model.uiState.value.generation)
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            auth.signOutAction = {
                signOut.await()
                auth.state.value = AuthenticationState(initialized = true)
            }
            model.signOut(model.uiState.value.generation)
            assertTrue(resources.last().closed)
            assertNull(model.uiState.value.ready)
            signOut.complete(Unit)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
        }
    }
}
