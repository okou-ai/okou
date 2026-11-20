package ai.okou.android.updates

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

internal fun Context.observeUpdateConnectivity(): Flow<Boolean> {
    val manager = checkNotNull(getSystemService(ConnectivityManager::class.java))
    return callbackFlow {
            val callback =
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        trySend(Unit)
                    }

                    override fun onCapabilitiesChanged(
                        network: Network,
                        networkCapabilities: NetworkCapabilities,
                    ) {
                        trySend(Unit)
                    }

                    override fun onLost(network: Network) {
                        trySend(Unit)
                    }
                }
            manager.registerDefaultNetworkCallback(callback)
            trySend(Unit)
            awaitClose { manager.unregisterNetworkCallback(callback) }
        }
        .conflate()
        .map {
            manager.activeNetwork
                ?.let(manager::getNetworkCapabilities)
                ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
        }
        .distinctUntilChanged()
}
