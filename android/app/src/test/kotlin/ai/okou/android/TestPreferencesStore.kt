package ai.okou.android

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow

/** The SDK IO boundary; production preference decoding, actions and UI remain real. */
internal class TestPreferencesStore : DataStore<Preferences> {
    val values = MutableStateFlow<Preferences>(emptyPreferences())
    var initialRead = CompletableDeferred<Unit>().apply { complete(Unit) }
    var readFailure = false
    var writeFailure = false
    var publishWrite = true
    var pending: Preferences? = null

    override val data: Flow<Preferences> = flow {
        initialRead.await()
        if (readFailure) throw IOException("Unavailable storage")
        emitAll(values)
    }

    override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences {
        if (writeFailure) throw IOException("Storage full")
        return transform(values.value).also {
            pending = it
            if (publishWrite) values.value = it
        }
    }
}
