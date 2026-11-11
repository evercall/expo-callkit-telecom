---
description: Platform requirements for expo-callkit-telecom — iOS 15.1+ (CallKit + PushKit), Android API 26+ (Jetpack androidx.core-telecom). Keep-alive notes for background WebSocket signalling.
---

# Platform notes

## iOS

- Requires the `voip` background mode and a VoIP push certificate.
- Uses [CallKit](https://developer.apple.com/documentation/callkit) + [PushKit](https://developer.apple.com/documentation/pushkit) + [WebRTC](https://webrtc.org/)'s `RTCAudioSession` for manual audio control.
- Minimum iOS version: **15.1**.

## Android

- Requires [`MANAGE_OWN_CALLS`](https://developer.android.com/reference/android/Manifest.permission#MANAGE_OWN_CALLS) permission.
- Minimum SDK: **26** (Android 8.0).
- Uses [`androidx.core:core-telecom`](https://developer.android.com/develop/connectivity/telecom/voip-app/telecom).
- Incoming calls come via [FCM](https://firebase.google.com/docs/cloud-messaging) data messages — the config plugin registers `ExpoCallKitTelecomMessagingService` automatically.

### Call ended while the app is killed

On a killed app, Android shows the incoming-call UI fully natively — no React context ever starts unless the user answers. That means a **decline** (or any call end) in that state cannot be delivered as a JS event: `onCallEnded` is intentionally excluded from the cold-start replay queue, so the event is dropped and the app never learns about it. If your backend needs to know (so the caller stops ringing immediately instead of waiting for a server timeout), register a manifest `BroadcastReceiver` for the package-internal broadcast the module fires in exactly that case.

Register the receiver via the config plugin, which writes the manifest entry. You supply the receiver class (e.g. in a [local Expo module](https://docs.expo.dev/modules/get-started/) or your `android/` source):

```js
// app.config.js / app.json plugin props
[
  "expo-callkit-telecom",
  { androidEventReceiver: ".CallEndedReceiver" },
]
```

```kotlin
class CallEndedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.getStringExtra("eventName") != "onCallEnded") return
        val payload = intent.getStringExtra("payload")?.let { JSONObject(it) } ?: return
        val session = payload.optJSONObject("session")
        val incomingCall = session?.optJSONObject("incomingCallEvent")
        val serverCallId = incomingCall?.optString("serverCallId")
        val metadata = incomingCall?.optJSONObject("metadata")
        // e.g. POST a decline to your backend (use goAsync() for the network call)
    }
}
```

The broadcast carries two extras: `eventName` (the call event that couldn't reach JS) and `payload`, a JSON string of the exact body JS would have received. Events that can't reach a live JS observer **and** aren't queued for cold-start replay (e.g. `onCallEnded`, `onCallReportedEnded`) are broadcast — filter on `eventName` for the ones you care about (the example above handles only `onCallEnded`). For these terminal events the payload embeds the full `session`, so your backend ids (`serverCallId`) and any push `metadata` (auth tokens, routing ids) are available without app-side state. The broadcast fires **only** when the event would otherwise be lost; an alive app with a mounted listener keeps receiving the normal JS event, and events that flush to JS on the next launch are never broadcast (so there's no double-delivery).

A complete working setup ships in the example app: `example/client/` sets `androidEventReceiver` in `app.config.ts` and copies `plugins/CallEndedReceiver.kt` into the generated android project — see "Testing system → app paths" in the example README for how to exercise it.

## VoIP push token types

The VoIP push token type is reported as `"APNS_VOIP"` on iOS and `"FCM"` on Android — send both to your backend so it knows which transport to use.

## Keeping connections alive in the background

This module hands the OS a CallKit/Core-Telecom call, which keeps the *process* alive during a call — but JS timers (`setInterval`, `setTimeout`) and JS-side network heartbeats are still subject to background throttling once the screen locks. If your media stack needs an app-level heartbeat (e.g. a WebSocket signalling channel) to survive the background, pair this module with [`react-native-nitro-keepalive-timer`](https://www.npmjs.com/package/react-native-nitro-keepalive-timer) to get native timers that fire reliably while a call is active.


## Telephony engine audio device selection

`AudioDevice`, `AudioDeviceDirection` and `AudioDeviceType` are exported by the
library. Enumerate through the engine and select through an existing session:

```typescript
const inputs = engine.getAudioDevices("input");
const outputs = engine.getAudioDevices("output");
const session = engine.getSession(sessionId);
const microphone = inputs.find((device) => device.id === chosenInputId);
const speaker = outputs.find((device) => device.id === chosenOutputId);
if (session && microphone) await session.setInput(microphone);
if (session && speaker) await session.setOutput(speaker);

const unsubscribe = engine.subscribeToAudioDevices(() => {
  // Refresh both lists; each device carries its current isActive value.
  refreshAudioDevices();
});
// Call unsubscribe() when the selector unmounts. engine.close() also cleans up.
```

IDs are opaque, direction-specific and valid only while the device remains
available. Do not persist them as durable hardware identifiers. `type` normalizes
common iOS and Android port kinds; `nativeType` retains the platform value,
including unrecognized future kinds (`type: "unknown"`). `friendlyName` is suitable
for display. `routing: "paired"` means selection can change both directions.

`isActive` is `true` when the device is on the observed native route, `false` when
an observed route identifies a different device, and `null` when activity cannot
be established reliably. It describes the route, not whether audio is flowing.
The frontend can highlight entries with `device.isActive === true` without
matching `AudioDevice.id` against native `AudioPort.uid` values:

```typescript
const activeOutput = engine.getAudioDevices("output")
  .find((device) => device.isActive === true);
```

Read a fresh list when `subscribeToAudioDevices` fires; returned objects are
snapshots. The last requested device is never marked active optimistically.
iOS matches inputs by their native UIDs, built-in outputs by port type, and known
paired outputs by their current duplex route. Ambiguous accessory identities or
missing routes produce `null`. Android outputs match the reported communication
device by ID; Android inputs currently always return `null` because this API
does not expose the active capture source. This avoids the inferred microphone
in the legacy `getAudioSession().currentRoute` being mistaken for an observation.
An active output selected through the system route picker may not appear in the
selectable device list on iOS; in that case no entry is marked active.

The native audio session is shared by all calls; these methods do not create
per-call hardware routes. Re-enumerate after connecting or disconnecting devices,
call activation and system route changes. Enumeration never activates audio or
requests microphone permissions.

### iOS

Input discovery uses `AVAudioSession.availableInputs`. Output discovery includes
the built-in speaker, the receiver on iPhones, and bidirectional accessories
selectable through their corresponding input (HFP/LE Bluetooth, wired headsets
and car audio). USB and line inputs remain selectable as inputs; their output
capabilities cannot be inferred safely from an input port alone. Selection uses WebRTC's locked `RTCAudioSession` wrapper for
`setPreferredInput` and `overrideOutputAudioPort`, preserving CallKit activation.
Headset input/output are coupled. iOS provides no `availableOutputs` API, so this
list cannot enumerate arbitrary AirPlay/A2DP or output-only accessories; those
require the system route picker. Available inputs depend on session category,
permissions and connected hardware. Promises resolve when the native preference
is accepted; route events report the actual system route.

### Android

Selection requires Android 12 / API 31 or later. Older releases return empty
lists and native selection rejects with `ERR_AUDIO_ROUTING_UNSUPPORTED`.
Outputs come from `AudioManager.availableCommunicationDevices`; inputs are the
capture devices with a matching communication output. Selecting an input chooses
its paired output because Android selects the capture source automatically.
The built-in microphone keeps the current built-in output when possible and
otherwise prefers the earpiece. Ambiguous accessory pairings reject.

The library declares `MODIFY_AUDIO_SETTINGS` and does not change the audio mode.
Managed Telecom and the system dialer retain routing priority. A routing promise
resolves only after the requested communication output is observed; a rejected
or unapplied request rejects rather than pretending success. A route not applied
within three seconds rejects with `ERR_AUDIO_ROUTE_NOT_APPLIED`; the app should
direct users to the native call screen in that case. Concurrent requests reject
with `ERR_AUDIO_ROUTE_BUSY`. The communication preference is cleared when the
last call ends. Guaranteed control under managed Telecom requires a separate
architecture decision about ownership of the system call UI.

Native references: [Android communication device routing](https://developer.android.com/reference/android/media/AudioManager#setCommunicationDevice(android.media.AudioDeviceInfo)),
[Apple available inputs](https://developer.apple.com/documentation/avfaudio/avaudiosession/availableinputs),
[Apple preferred input](https://developer.apple.com/documentation/avfaudio/avaudiosession/setpreferredinput(_:)).


## Multiple calls

The native stores and the telephony engine track calls by ID. Use
`getCallSessions()` to enumerate native calls and `getCallSession(nativeCallId)`
to inspect one call. `getActiveCallSession()` remains a legacy API returning
only the first stored call; it does not identify the foreground call.
`reportIncomingCall()` returns the newly assigned native call ID. Incoming SIP
sessions match push-reported calls by `incomingCallEvent.serverCallId`, which
must equal the SIP Call-ID; caller identity is not a safe call identifier.

iOS permits two independent CallKit call groups with one call per group,
supporting one active consultation call and one held call. Starting another
outgoing native call requests that connected, unheld calls be held in the same
CallKit transaction. Calls are not grouped into a local conference. Android
managed Telecom controls call admission and switching; system hold and resume
actions update the corresponding Connection and SIP session. The OS can still
reject new calls when its capacity or calling policy does not permit them.

Audio hardware and the Android microphone foreground service are shared across
calls. Ending or failing one call preserves these resources while another call
remains. Applications must apply native hold actions to their media; the
included JsSIP engine handles these events. Transfer signaling is exposed by the
session and engine APIs described below.


## Call transfers

The JsSIP engine exposes the same transfer entry points as WebphoneLib:

```typescript
// Blind transfer: pass a full SIP URI.
const transferred = await source.blindTransfer("sip:123@example.com");

// Attended transfer: hold the original call, establish a consultation call,
// then pass the two sessions (or objects containing their session IDs).
await source.hold();
const consultation = await engine.invite("sip:456@example.com");
await consultation.accepted();
const attended = await engine.attendedTransfer(source, consultation);
// Equivalent: await source.attendedTransfer(consultation);
```

Both legs must be established and belong to the same engine for an attended
transfer. The target dialog is encoded in the SIP REFER's Replaces parameter by
JsSIP; IDs in these APIs are engine session IDs, not native call IDs.

As in WebphoneLib, `true` means the server accepted the REFER request, rather
than that the referred destination has answered. On acceptance the source leg
is terminated through its normal SIP/native cleanup path. The consultation leg
is not locally terminated; the server controls its subsequent lifecycle.
Rejection, transport/request failure, a call ending while REFER is pending, or
a 20-second timeout returns `false`. Late responses after a timeout do not end
the source call. Invalid targets, missing/ended/unestablished sessions, self
transfers, and another transfer pending on the source reject the promise.
Rejected or timed-out transfers do not automatically unhold or end either call;
the application decides whether to retry, resume, or end the consultation.

These are SIP transfers and require server support for REFER/Replaces. They do
not depend on a native Android transfer button or CallKit conferencing.


### iOS push-to-SIP correlation

The native incoming-call registry records push origin before reporting to CallKit.
When a push contains a backend call ID, only the identical SIP `Call-ID` can claim it.
An ID-less push uses a conservatively normalized caller handle and, when supplied,
account ID. A generated native/payload UUID is never treated as a backend call ID.
The engine serializes admission, claims a native call once, and creates a native
call for ordinary SIP-only INVITEs. Multiple eligible live handle matches are rejected
as ambiguous rather than attached to an arbitrary call.

Ringing uses the configured incoming timeout (45 seconds by default), capped by a
valid payload `expiresAt`. Answering before expiry starts a separate connection
window (30 seconds by default); duplicate answers do not extend it. Admission and
answering validate absolute deadlines, including after asynchronous audio setup.
Established media is not ended by these incoming-call deadlines.

Terminal IDs are persisted for up to 24 hours, retaining at most 256 historical
records. Previous-process native UUIDs are terminal on restoration. For ID-less,
unclaimed push calls, handle-based terminal rejection is limited to five seconds
after expiry/end; a fresh live push takes precedence. Outside that window an
unknown INVITE is treated as a SIP-only call. This deliberately limits false
rejection of new calls from the same caller. Without a backend call ID or server
creation timestamp, delayed and fresh same-caller calls cannot be distinguished
reliably. ID-less duplicate pushes also cannot be safely deduplicated.

These rules concern iOS admission. Android FCM delivery age and stale-message
handling require a separate policy; increasing the iOS matching window does not
solve delayed FCM delivery.
