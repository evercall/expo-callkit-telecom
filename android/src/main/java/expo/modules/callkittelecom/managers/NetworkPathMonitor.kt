package expo.modules.callkittelecom.managers

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import expo.modules.callkittelecom.utils.CallKitTelecomLog

/** Coarse default-path changes only. Network identity stays native; no IPs or SSIDs cross the bridge. */
internal class NetworkPathMonitor(
    context: Context,
    private val onPathChanged: (Map<String, Any>) -> Unit,
) {
    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private var registeredCallback: ConnectivityManager.NetworkCallback? = null
    private var currentDefaultNetwork: Network? = null
    private var previousPath: NetworkPathSnapshot? = null

    private data class NetworkPathSnapshot(
        val network: Network?,
        val status: String,
        val interfaces: List<String>,
    )

    fun start() {
        mainHandler.post {
            if (registeredCallback != null) return@post
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    mainHandler.post {
                        if (registeredCallback !== this) return@post
                        // Wait for the supplied capabilities rather than querying
                        // synchronous network properties inside a callback.
                        currentDefaultNetwork = network
                    }
                }

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    mainHandler.post {
                        if (registeredCallback !== this || currentDefaultNetwork != network) return@post
                        publishPath(network, capabilities)
                    }
                }

                override fun onLost(network: Network) {
                    mainHandler.post {
                        // A late onLost for the old default must not erase its replacement.
                        if (registeredCallback !== this || currentDefaultNetwork != network) return@post
                        currentDefaultNetwork = null
                        publishPath(null, null)
                    }
                }
            }
            registeredCallback = callback
            runCatching {
                connectivityManager.registerDefaultNetworkCallback(callback)
            }.onFailure {
                registeredCallback = null
                CallKitTelecomLog.w("ExpoCallKitTelecom.Network") { "Unable to observe the default network; SIP and ICE observers remain active" }
                return@post
            }

            // A default callback sends no initial onLost when already offline.
            // Seed that state once, outside the asynchronous network callbacks.
            currentDefaultNetwork = connectivityManager.activeNetwork
            val initialCapabilities = currentDefaultNetwork?.let(connectivityManager::getNetworkCapabilities)
            publishPath(currentDefaultNetwork, initialCapabilities)
        }
    }

    fun stop() {
        mainHandler.post {
            val callback = registeredCallback ?: return@post
            registeredCallback = null
            currentDefaultNetwork = null
            previousPath = null
            runCatching {
                connectivityManager.unregisterNetworkCallback(callback)
            }.onFailure {
                CallKitTelecomLog.w("ExpoCallKitTelecom.Network") { "Unable to unregister the default-network observer" }
            }
        }
    }

    private fun publishPath(network: Network?, capabilities: NetworkCapabilities?) {
        val transports = listOf(
            NetworkCapabilities.TRANSPORT_WIFI to "wifi",
            NetworkCapabilities.TRANSPORT_CELLULAR to "cellular",
            NetworkCapabilities.TRANSPORT_ETHERNET to "ethernet",
            NetworkCapabilities.TRANSPORT_VPN to "vpn",
        )
        val interfaces = transports.filter { capabilities?.hasTransport(it.first) == true }.map { it.second }
        val status = if (network != null && capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) {
            "satisfied"
        } else {
            "unsatisfied"
        }
        val path = NetworkPathSnapshot(network, status, interfaces)
        if (path == previousPath) return
        val initial = previousPath == null
        previousPath = path
        onPathChanged(mapOf("status" to status, "interfaces" to interfaces, "initial" to initial))
    }
}
