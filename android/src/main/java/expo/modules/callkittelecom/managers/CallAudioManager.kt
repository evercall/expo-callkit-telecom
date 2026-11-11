package expo.modules.callkittelecom.managers

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.callkittelecom.store.CallStore
import java.util.UUID
import expo.modules.callkittelecom.events.CallEventEmitter
import expo.modules.callkittelecom.events.CallEvents
import expo.modules.callkittelecom.models.CallSession
import expo.modules.callkittelecom.utils.CallKitTelecomLog
import expo.modules.callkittelecom.utils.PermissionUtils

/** Observes managed-Telecom audio without competing with the system dialer for routing. */
object CallAudioManager {
    private const val TAG = "ExpoCallKitTelecom.Audio"
    private lateinit var context: Context
    private lateinit var audioManager: AudioManager
    private var initialized = false
    internal var isActive = false
    private var routeRequestPending = false

    fun initialize(appContext: Context) {
        if (initialized) return
        context = appContext.applicationContext
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.registerAudioDeviceCallback(
            object : AudioDeviceCallback() {
                override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) = emitRouteChanged()
                override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) = emitRouteChanged()
            },
            null,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.addOnCommunicationDeviceChangedListener(context.mainExecutor) { emitRouteChanged() }
        }
        initialized = true
    }

    // AudioManager selects a communication sink and lets Android pair its source.
    // We never change audio mode: managed Telecom retains ownership of the call.
    fun getAudioDevices(direction: String): List<Map<String, Any?>> {
        require(direction == "input" || direction == "output") { "Invalid audio device direction" }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return emptyList()
        val outputs = audioManager.availableCommunicationDevices
        val currentOutput = audioManager.communicationDevice
        val devices = if (direction == "output") outputs else
            audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { input ->
                matchingOutputs(input, outputs).isNotEmpty()
            }
        return devices.map { device ->
            mapOf(
                "id" to "$direction:${device.id}",
                "direction" to direction,
                "type" to deviceType(device.type),
                "nativeType" to device.type.toString(),
                "friendlyName" to deviceName(device),
                "routing" to "paired",
                // communicationDevice identifies only the sink. Do not present
                // a guessed matching source as an observed active microphone.
                "isActive" to if (direction == "output") currentOutput?.let { it.id == device.id } else null,
            )
        }
    }

    private fun deviceName(device: AudioDeviceInfo): String = when (device.type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Phone microphone"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Earpiece"
        else -> device.productName.toString()
    }

    private fun matchingOutputs(input: AudioDeviceInfo, outputs: List<AudioDeviceInfo>): List<AudioDeviceInfo> =
        outputs.filter { output ->
            if (input.type == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                output.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE || output.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            } else {
                input.type == output.type && input.address == output.address
            }
        }

    private fun deviceType(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin_mic"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> "builtin_speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "builtin_earpiece"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth_hfp"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth_a2dp"
        AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_BLE_BROADCAST -> "bluetooth_le"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired_headphones"
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY, AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
        AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, AudioDeviceInfo.TYPE_HDMI_EARC -> "hdmi"
        AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL -> "line"
        AudioDeviceInfo.TYPE_HEARING_AID -> "hearing_aid"
        else -> "unknown"
    }

    fun setAudioDevice(callId: UUID, direction: String, id: String, promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            promise.reject("ERR_AUDIO_ROUTING_UNSUPPORTED", "Audio device selection requires Android 12 or later", null)
            return
        }
        // Serialize requests on the main thread and confirm the actual route. An
        // accepted AudioManager preference can be overridden by managed Telecom.
        Handler(Looper.getMainLooper()).post {
            if (routeRequestPending) {
                promise.reject("ERR_AUDIO_ROUTE_BUSY", "Another audio route request is pending", null)
                return@post
            }
            routeRequestPending = true
            try {
                check(CallStore.session(callId) != null) { "Call is no longer available" }
                require(getAudioDevices(direction).any { it["id"] == id }) { "Audio device is no longer available" }
                val outputs = audioManager.availableCommunicationDevices
                val output = if (direction == "output") outputs.firstOrNull { "output:${it.id}" == id } else {
                    val input = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).first { "input:${it.id}" == id }
                    val matches = matchingOutputs(input, outputs)
                    // Preserve the current built-in output when changing to its mic.
                    val current = audioManager.communicationDevice
                    matches.firstOrNull { it.id == current?.id }
                        ?: matches.singleOrNull()
                        ?: matches.firstOrNull { input.type == AudioDeviceInfo.TYPE_BUILTIN_MIC && it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                }
                requireNotNull(output) { "No unambiguous communication route for this input" }
                check(audioManager.setCommunicationDevice(output)) { "Android rejected the audio route request" }
                val deadline = android.os.SystemClock.elapsedRealtime() + 3000
                val handler = Handler(Looper.getMainLooper())
                val confirm = object : Runnable {
                    override fun run() {
                        if (CallStore.session(callId) == null) {
                            routeRequestPending = false
                            promise.reject("ERR_AUDIO_DEVICE", "Call ended during audio route selection", null)
                            return
                        }
                        if (audioManager.communicationDevice?.id == output.id) {
                            routeRequestPending = false
                            promise.resolve(null)
                            return
                        }
                        if (android.os.SystemClock.elapsedRealtime() >= deadline) {
                            routeRequestPending = false
                            audioManager.clearCommunicationDevice()
                            promise.reject("ERR_AUDIO_ROUTE_NOT_APPLIED", "Managed Telecom did not apply the requested route; use the system call screen", null)
                            return
                        }
                        handler.postDelayed(this, 50)
                    }
                }
                handler.post(confirm)
            } catch (error: Exception) {
                routeRequestPending = false
                promise.reject("ERR_AUDIO_DEVICE", error.message, error)
            }
        }
    }

    fun getAudioSessionState(): Map<String, Any?> {
        val sampleRate = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toDoubleOrNull()
        val frames = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toDoubleOrNull()
        return mapOf(
            "isActive" to isActive,
            "isOtherAudioPlaying" to audioManager.isMusicActive,
            "category" to "communication",
            "mode" to modeString(audioManager.mode),
            "sampleRate" to sampleRate,
            "ioBufferDuration" to if (sampleRate != null && frames != null) frames / sampleRate else null,
            "inputNumberOfChannels" to 1,
            "outputNumberOfChannels" to 2,
            "microphonePermission" to PermissionUtils.microphonePermission(context),
            "currentRoute" to currentRouteMap(),
            "availableRoutes" to availableRoutesMap(),
        )
    }

    fun prepareAudioSessionForCall(hasVideo: Boolean) {
        require(!hasVideo) { "Managed migration mode supports audio calls only" }
    }

    fun restoreAudioSession() = Unit

    /** Route controls are supplied by the system InCallService in managed mode. */
    fun setAudioSessionPortOverride(enabled: Boolean) {
        CallKitTelecomLog.d(TAG) { "Ignoring route override ($enabled); managed Telecom owns routing" }
    }

    fun onAudioActivated(calls: List<CallSession>) {
        if (!initialized) return
        isActive = true
        CallEventEmitter.send(CallEvents.AUDIO_SESSION_ACTIVATED, callInfo(calls))
        emitRouteChanged()
    }

    fun onAudioDeactivated(calls: List<CallSession>) {
        if (!initialized) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.clearCommunicationDevice()
        DialtonePlayer.stop()
        isActive = false
        CallEventEmitter.send(CallEvents.AUDIO_SESSION_DEACTIVATED, callInfo(calls))
        emitRouteChanged()
    }

    private fun callInfo(calls: List<CallSession>): Map<String, Any?> =
        mapOf("calls" to calls.map { mapOf("id" to it.id.toString(), "status" to it.status.value) })

    private fun emitRouteChanged() {
        if (!initialized) return
        CallEventEmitter.send(
            CallEvents.AUDIO_ROUTE_CHANGED,
            mapOf("currentRoute" to currentRouteMap(), "availableRoutes" to availableRoutesMap()),
        )
    }

    private fun currentRouteMap(): Map<String, Any?> {
        val output =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.communicationDevice
            else audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull()
        val input = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { candidate ->
            when (output?.type) {
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> candidate.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                AudioDeviceInfo.TYPE_WIRED_HEADSET -> candidate.type == AudioDeviceInfo.TYPE_WIRED_HEADSET
                else -> candidate.type == AudioDeviceInfo.TYPE_BUILTIN_MIC
            }
        }
        return mapOf(
            "inputs" to listOfNotNull(input?.let(::portMap)),
            "outputs" to listOfNotNull(output?.let(::portMap)),
        )
    }

    private fun availableRoutesMap(): List<Map<String, String>> =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map(::portMap)

    private fun portMap(info: AudioDeviceInfo): Map<String, String> =
        mapOf("portType" to portTypeString(info.type), "portName" to info.productName.toString(), "uid" to info.id.toString())

    private fun portTypeString(type: Int): String =
        when (type) {
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "builtInReceiver"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "builtInSpeaker"
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "headphones"
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetoothA2DP"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetoothHFP"
            AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetoothLE"
            AudioDeviceInfo.TYPE_HDMI -> "hdmi"
            AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY, AudioDeviceInfo.TYPE_USB_HEADSET -> "usbAudio"
            AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL -> "lineOut"
            else -> "android_$type"
        }

    private fun modeString(mode: Int): String =
        when (mode) {
            AudioManager.MODE_IN_COMMUNICATION -> "inCommunication"
            AudioManager.MODE_IN_CALL -> "inCall"
            AudioManager.MODE_NORMAL -> "normal"
            AudioManager.MODE_RINGTONE -> "ringtone"
            else -> "unknown"
        }
}
