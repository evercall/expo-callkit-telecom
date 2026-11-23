// Compiles the production Kotlin observer against deterministic Android stubs.
// No emulator is needed; actual device connectivity remains a separate check.
const assert = require("node:assert/strict");
const { existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir, homedir } = require("node:os");
const { join, resolve, delimiter } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const cachedJar = (group, artifact, version) => {
	const folder = join(homedir(), ".gradle/caches/modules-2/files-2.1", group, artifact, version);
	if (!existsSync(folder)) return undefined;
	for (const hash of readdirSync(folder)) {
		const jar = join(folder, hash, `${artifact}-${version}.jar`);
		if (existsSync(jar)) return jar;
	}
};
const compiler = cachedJar("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.1.20");
const stdlib = cachedJar("org.jetbrains.kotlin", "kotlin-stdlib", "2.1.20");
const compilerDependencies = [
	compiler, stdlib,
	cachedJar("org.jetbrains.kotlin", "kotlin-script-runtime", "2.1.20"),
	cachedJar("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10") ?? cachedJar("org.jetbrains.kotlin", "kotlin-reflect", "2.0.21"),
	cachedJar("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"),
	cachedJar("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
	cachedJar("org.jetbrains", "annotations", "13.0"),
];
test("Android production path observer coalesces events and ignores stale network/callback notifications", {
	skip: compilerDependencies.some((jar) => !jar) ? "Requires the locally cached Kotlin 2.1.20 compiler and runtime" : false,
}, () => {
	const folder = mkdtempSync(join(tmpdir(), "callkit-android-network-"));
	const files = {
		"Context.kt": `
package android.content
import android.net.ConnectivityManager
class Context(val manager: ConnectivityManager) {
    val applicationContext get() = this
    fun getSystemService(name: String): Any = manager
    companion object { const val CONNECTIVITY_SERVICE = "connectivity" }
}`,
		"Network.kt": `
package android.net
data class Network(val id: Int)
class NetworkCapabilities(private val transports: Set<Int>, private val internet: Boolean = true) {
    fun hasTransport(type: Int) = type in transports
    fun hasCapability(type: Int) = internet
    companion object {
        const val TRANSPORT_WIFI = 1
        const val TRANSPORT_CELLULAR = 2
        const val TRANSPORT_ETHERNET = 3
        const val TRANSPORT_VPN = 4
        const val NET_CAPABILITY_INTERNET = 5
    }
}
class ConnectivityManager {
    var activeNetwork: Network? = null
    var callback: NetworkCallback? = null
    var registrationCount = 0
    var unregisterCount = 0
    var failRegistration = false
    val capabilities = mutableMapOf<Network, NetworkCapabilities>()
    open class NetworkCallback {
        open fun onAvailable(network: Network) {}
        open fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {}
        open fun onLost(network: Network) {}
    }
    fun registerDefaultNetworkCallback(callback: NetworkCallback) {
        check(!failRegistration)
        check(this.callback == null)
        this.callback = callback
        registrationCount++
    }
    fun unregisterNetworkCallback(callback: NetworkCallback) {
        check(this.callback === callback)
        this.callback = null
        unregisterCount++
    }
    fun getNetworkCapabilities(network: Network) = capabilities[network]
}`,
		"Handler.kt": `
package android.os
class Looper { companion object { fun getMainLooper() = Looper() } }
class Handler(looper: Looper) {
    fun post(action: Runnable): Boolean { actions.add(action); return true }
    companion object {
        private val actions = ArrayDeque<Runnable>()
        fun flush() { while (actions.isNotEmpty()) actions.removeFirst().run() }
    }
}`,
		"Log.kt": `
package expo.modules.callkittelecom.utils
object CallKitTelecomLog { fun w(tag: String, message: () -> String) {} }
`,
		"NetworkPathMonitorHarness.kt": `
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import expo.modules.callkittelecom.managers.NetworkPathMonitor

fun main() {
    val manager = ConnectivityManager()
    val events = mutableListOf<Map<String, Any>>()
    val monitor = NetworkPathMonitor(Context(manager)) { events.add(it) }
    monitor.start()
    monitor.start()
    Handler.flush()
    check(manager.registrationCount == 1)
    check(events.single() == mapOf("initial" to true, "status" to "unsatisfied", "interfaces" to emptyList<String>()))
    val callback = manager.callback!!
    val wifi = Network(1)
    val cellular = Network(2)
    val otherCellular = Network(3)
    val wifiCapabilities = NetworkCapabilities(setOf(NetworkCapabilities.TRANSPORT_WIFI))
    val cellularCapabilities = NetworkCapabilities(setOf(NetworkCapabilities.TRANSPORT_CELLULAR))

    callback.onAvailable(wifi)
    Handler.flush()
    check(events.size == 1) // Wait for capabilities instead of a racy synchronous query.
    callback.onCapabilitiesChanged(wifi, wifiCapabilities)
    callback.onCapabilitiesChanged(wifi, wifiCapabilities)
    Handler.flush()
    check(events.size == 2)
    check(events.last()["initial"] == false)
    check(events.last()["status"] == "satisfied")
    check(events.last()["interfaces"] == listOf("wifi"))

    callback.onAvailable(cellular)
    callback.onCapabilitiesChanged(cellular, cellularCapabilities)
    callback.onLost(wifi) // Late loss of the replaced default is irrelevant.
    Handler.flush()
    check(events.size == 3)
    check(events.last()["interfaces"] == listOf("cellular"))
    check(events.last()["status"] == "satisfied")

    callback.onAvailable(otherCellular)
    callback.onCapabilitiesChanged(otherCellular, cellularCapabilities)
    Handler.flush()
    check(events.size == 4) // Same transport, different default network still triggers recovery.
    callback.onLost(otherCellular)
    Handler.flush()
    check(events.size == 5)
    check(events.last()["status"] == "unsatisfied")
    check(events.all { it.keys == setOf("initial", "status", "interfaces") })

    monitor.stop()
    Handler.flush()
    check(manager.unregisterCount == 1)
    callback.onAvailable(wifi)
    callback.onCapabilitiesChanged(wifi, wifiCapabilities)
    Handler.flush()
    check(events.size == 5) // Already queued callbacks cannot outlive observation.

    manager.activeNetwork = wifi
    manager.capabilities[wifi] = wifiCapabilities
    monitor.start()
    Handler.flush()
    check(events.size == 6)
    check(events.last()["initial"] == true)
    check(events.last()["interfaces"] == listOf("wifi"))
    callback.onLost(wifi) // Callback from the previous subscription cannot erase current state.
    Handler.flush()
    check(events.size == 6)
    monitor.stop()
    Handler.flush()
    check(manager.unregisterCount == 2)

    manager.failRegistration = true
    monitor.start()
    Handler.flush()
    check(events.size == 6)
    manager.failRegistration = false
    monitor.start()
    Handler.flush()
    check(events.size == 7) // A failed registration can be retried; it leaves no stale callback.
    monitor.stop()
    Handler.flush()
    println("network-path-monitor assertions passed")
}
`,
	};
	try {
		const sources = [];
		for (const [name, source] of Object.entries(files)) {
			const filename = join(folder, name);
			writeFileSync(filename, source);
			sources.push(filename);
		}
		const classes = join(folder, "classes");
		mkdirSync(classes);
		const compilation = spawnSync("java", [
			"-cp", compilerDependencies.join(delimiter), "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
			"-no-stdlib", "-no-reflect", "-jvm-target", "17",
			"-classpath", [stdlib, compilerDependencies.at(-1)].join(delimiter),
			"-d", classes,
			resolve(__dirname, "../../../android/src/main/java/expo/modules/callkittelecom/managers/NetworkPathMonitor.kt"),
			...sources,
		], { encoding: "utf8", timeout: 60_000 });
		assert.equal(compilation.status, 0, compilation.error?.message ?? compilation.stdout + compilation.stderr);
		const execution = spawnSync("java", ["-cp", [classes, stdlib].join(delimiter), "NetworkPathMonitorHarnessKt"], {
			encoding: "utf8", timeout: 15_000,
		});
		assert.equal(execution.status, 0, execution.error?.message ?? execution.stdout + execution.stderr);
		assert.match(execution.stdout, /network-path-monitor assertions passed/);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
