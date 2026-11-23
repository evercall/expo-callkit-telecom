import { AudioDeviceModule, AudioEngineAvailability, registerGlobals, } from "@livekit/react-native-webrtc";
import type { EventSubscription } from "expo-modules-core";
import * as JsSIP from "jssip";
import { NativeModules, Platform } from "react-native";

import ExpoCallKitTelecomModule from "../ExpoCallKitTelecomModule";
import { SessionRecovery } from "./SessionRecovery";
import { sessionTermination } from "./SessionTermination";
import type { EndEvent, IncomingDTMFEvent, OutgoingDTMFEvent, RTCSession, } from "jssip/lib/RTCSession";
import type { RTCSessionEvent } from "jssip/lib/UA";

import { addAudioRouteChangedListener, addAudioSessionActivatedListener, addAudioSessionDeactivatedListener, addCallAnsweredListener, addCallEndedListener, addCallIntentReceivedListener, addCallSessionRemovedListener, addDTMFListener, addSetHeldActionListener, addSetMutedActionListener, endCall, failIncomingCallConnected, fulfillIncomingCallConnected, getAudioSession, getCallSessions, reportCallEnded, reportIncomingCall, reportOutgoingCallConnected, startOutgoingCall, } from "../Calls";
import type { AudioDevice, AudioDeviceDirection, TelephonyConfiguration, TelephonyEngine, TelephonyError, TelephonyErrorListener, TelephonyErrorOperation, TelephonySession, TelephonySnapshot, TelephonySnapshotListener, } from "./TelephonyEngine.types";
import { TelephonyClientStatus, TelephonySessionStatus, } from "./TelephonyEngine.types";
import { JsSipSession } from './JsSipSession';
import { Direction, ErrorContext, SipFailureEvent } from '../Calls.types';
import { logDtmf } from '../utils/log';
import { errorCode, errorMessage, mediaFailureError, sipFailureError } from '../utils/errors';
import { decodeSipUser, validateDtmfTones } from '../utils/sip';
import { requiredPermissions } from '../utils/permissions';
import { AUDIO_OPTIONS, INVITE_DTMF_DELAY_MS, REGISTRATION_TIMEOUT_MS } from '../constants';


/** React Native JsSIP engine with native CallKit/Telecom state projection. */
export class JsSipTelephonyEngine implements TelephonyEngine {
	private configuration?: TelephonyConfiguration;
	private ua?: JsSIP.UA;
	private clientStatus = TelephonyClientStatus.DISCONNECTED;
	private revision = 0;
	private closed = false;
	private readonly sessions = new Map<string, JsSipSession>();
	private readonly recoveries = new Map<string, SessionRecovery>();
	private readonly nativeEnding = new Set<string>();
	private networkPathAvailable = true;
	private readonly sessionsByNativeId = new Map<string, JsSipSession>();
	private readonly listeners = new Set<TelephonySnapshotListener>();
	private readonly errorListeners = new Set<TelephonyErrorListener>();
	private readonly nativeSubscriptions: EventSubscription[];
	private readonly pendingAnswerRequest = new Map<string, string>();
	private audioQueue: Promise<void> = Promise.resolve();
	private incomingQueue: Promise<void> = Promise.resolve();
	private readonly answeringNativeIds = new Set<string>();

	constructor() {
		registerGlobals();
		if (Platform.OS === "ios") {
			const rtpModule = NativeModules.ExpoCallKitRtpDtmf;
			logDtmf("iOS DTMF runtime", {}, {
				javascriptScheduler: "native-worker-queue-v2",
				nativeSchedulerVersion: rtpModule?.dtmfSchedulerVersion ?? "unavailable",
				nativeSchedulerAvailable: typeof rtpModule?.scheduleRtpDtmf === "function",
			});
		}
		this.nativeSubscriptions = [
			...((Platform.OS === "ios" || Platform.OS === "android") && typeof ExpoCallKitTelecomModule.addListener === "function"
				? [ExpoCallKitTelecomModule.addListener("onNetworkPathChanged", (event: { initial: boolean; status: string; interfaces: string[] }) => {
					if (this.closed) return;
					this.networkPathAvailable = event.status === "satisfied";
					if (event.initial) return;
					for (const recovery of this.recoveries.values()) recovery.requestRecovery("network-change");
				})]
				: []),
			...(Platform.OS === "ios"
				? [
					addAudioSessionActivatedListener(() =>
						this.runAsync("audioSession", () => this.synchronizeCallKitAudio(), {})
					),
					addAudioSessionDeactivatedListener(() =>
						this.runAsync("audioSession", () => this.synchronizeCallKitAudio(), {})
					),
				]
				: []),
			addCallAnsweredListener(({ id, requestId }) =>
				this.runAsync(
					"answerFromSystem",
					() => this.answerFromSystem(id, requestId),
					{
						nativeCallId: id,
					}
				)
			),
			addCallEndedListener(({ id }) =>
				this.runAsync("endFromSystem", () => this.endFromSystem(id), {
					nativeCallId: id,
				})
			),
			addCallSessionRemovedListener(({ id }) =>
				this.runAsync("endFromSystem", () => this.endFromSystem(id), { nativeCallId: id })
			),
			addCallIntentReceivedListener((event) =>
				this.runAsync(
					"callFromSystem",
					() => this.callFromSystem(event.handle, event.nativeCallId),
					{ nativeCallId: event.nativeCallId }
				)
			),
			addSetMutedActionListener(({ id, isMuted }) =>
				this.runSync("muteFromSystem", () => this.muteFromSystem(id, isMuted), {
					nativeCallId: id,
				})
			),
			addSetHeldActionListener(({ id, isOnHold }) =>
				this.runSync(
					"holdFromSystem",
					() => this.holdFromSystem(id, isOnHold),
					{
						nativeCallId: id,
					}
				)
			),
			addDTMFListener(({ id, digits }) =>
				this.runAsync(
					"sendDtmfFromSystem",
					async () => this.sessionsByNativeId.get(id)?.dtmf(digits),
					{ nativeCallId: id }
				)
			),
		];
		this.runAsync("audioSession", () => this.synchronizeCallKitAudio(), {});
	}

	/** @internal Coordinates the AudioEngine backend with native CallKit ownership. */
	synchronizeCallKitAudio(): Promise<void> {
		if (Platform.OS !== "ios") return Promise.resolve();
		const synchronize = async () => {
			// Read at execution time: queued events can be stale, and PushKit can
			// activate a call before the JS engine subscribes to activation events.
			const active = !this.closed && getAudioSession().isActive;
			await AudioDeviceModule.setEngineAvailability(
				active ? AudioEngineAvailability.default : AudioEngineAvailability.none
			);
			this.logAudioEngineState(active ? "CallKit active" : "CallKit inactive");
		};
		const result = this.audioQueue.then(synchronize, synchronize);
		// A failed transition must be reported, but must not poison later recovery.
		this.audioQueue = result.catch(() => undefined);
		return result;
	}

	async reconfigure(configuration: TelephonyConfiguration): Promise<void> {
		if (this.closed) throw new Error("Telephony engine is closed");
		await this.disconnect();
		this.configuration = configuration;
	}

	getConfiguration(): TelephonyConfiguration | undefined {
		return this.configuration;
	}

	async connect(): Promise<boolean> {
		if (this.closed) throw new Error("Telephony engine is closed");
		if (!this.configuration)
			throw new Error("Telephony engine is not configured");
		if (this.ua?.isConnected() && this.ua.isRegistered()) return true;

		await this.synchronizeCallKitAudio();
		const account = this.configuration.account;
		this.setClientStatus(TelephonyClientStatus.CONNECTING);
		const ua = new JsSIP.UA({
			sockets: [new JsSIP.WebSocketInterface(account.websocketUrl)],
			uri: account.uri,
			contact_uri: account.contactUri,
			authorization_user: account.authorizationUser,
			password: account.password,
			display_name: account.displayName,
			register_expires: account.registrationExpiresSeconds ?? 60,
			user_agent: account.userAgent,
			connection_recovery_min_interval: Math.max(
				1,
				Math.round(
					(this.configuration.registrationRetry?.initialDelayMs ?? 2000) / 1000
				)
			),
			connection_recovery_max_interval: Math.max(
				2,
				Math.round(
					(this.configuration.registrationRetry?.maximumDelayMs ?? 30000) / 1000
				)
			),
		});
		this.ua = ua;
		this.bindUa(ua);

		return new Promise<boolean>((resolve, reject) => {
			let timeout: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timeout);
				ua.removeListener("registered", onRegistered);
				ua.removeListener("registrationFailed", onFailure);
				ua.removeListener("disconnected", onDisconnected);
			};
			const onRegistered = () => {
				cleanup();
				resolve(true);
			};
			const onFailure = (event: SipFailureEvent) => {
				cleanup();
				reject(sipFailureError("SIP registration failed", event));
			};
			const onDisconnected = (event: SipFailureEvent) =>
				onFailure({
					...event,
					reason: event.reason || "disconnected before registration",
				});
			ua.once("registered", onRegistered);
			ua.once("registrationFailed", onFailure);
			ua.once("disconnected", onDisconnected);
			timeout = setTimeout(
				() => onFailure({ cause: "SIP registration timed out" }),
				REGISTRATION_TIMEOUT_MS
			);
			ua.start();
		});
	}

	async disconnect(): Promise<void> {
		if (!this.ua) return;
		this.setClientStatus(TelephonyClientStatus.DISCONNECTING);
		this.disposeRecoveries();
		this.ua.stop();
		this.ua.removeAllListeners();
		this.ua = undefined;
		this.setClientStatus(TelephonyClientStatus.DISCONNECTED);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.disposeRecoveries();
		this.ua?.terminateSessions();
		for (const nativeCallId of [...this.pendingAnswerRequest.keys()]) {
			await this.clearPendingAnswer(nativeCallId);
			await reportCallEnded(nativeCallId, "failed");
		}
		await this.disconnect();
		this.nativeSubscriptions.splice(0).forEach((subscription) => subscription.remove());
		this.listeners.clear();
		this.errorListeners.clear();
		await this.synchronizeCallKitAudio();
	}

	isConnected(): boolean {
		return this.ua?.isConnected() === true && this.ua.isRegistered();
	}

	async invite(uri: string, tones?: string): Promise<TelephonySession> {
		if (!this.ua || !this.isConnected() || !this.configuration)
			throw new Error("SIP client is not connected");
		if (!uri.startsWith("sip:")) {
			throw new Error("SIP uri malformed in invite");
		}
		if (tones !== undefined) validateDtmfTones(tones);
		await this.synchronizeCallKitAudio();
		const handle = decodeSipUser(uri.replace(/^sip:/, "").split("@")[0]);
		const nativeCallId = await startOutgoingCall(
			{ id: uri, phoneNumber: handle, displayName: handle },
			{ hasVideo: false }
		);
		try {
			const rtcSession = this.ua.call(uri, { ...AUDIO_OPTIONS, pcConfig: { iceServers: this.configuration.iceServers ?? [] } });
			return this.attachSession(
				rtcSession,
				nativeCallId,
				rtcSession.id,
				"outgoing",
				tones
			);
		} catch (error) {
			await reportCallEnded(nativeCallId, "failed");
			throw error;
		}
	}

	getSession(id: string): TelephonySession | undefined {
		return this.sessions.get(id);
	}

	getSessions(): readonly TelephonySession[] {
		return [...this.sessions.values()];
	}

	async attendedTransfer(a: { id: string }, b: { id: string }): Promise<boolean> {
		const source = this.sessions.get(a.id);
		if (!source) throw new Error("Session A not found");
		const target = this.sessions.get(b.id);
		if (!target) throw new Error("Session B not found");
		return source.attendedTransfer(target);
	}

	getAudioDevices(direction: AudioDeviceDirection): readonly AudioDevice[] {
		if (this.closed) throw new Error("Telephony engine is closed");
		if (direction !== "input" && direction !== "output") throw new Error("Invalid audio device direction");
		return ExpoCallKitTelecomModule.getAudioDevices(direction);
	}

	subscribeToAudioDevices(listener: () => void): () => void {
		if (this.closed) throw new Error("Telephony engine is closed");
		const subscription = addAudioRouteChangedListener(() => listener());
		this.nativeSubscriptions.push(subscription);
		return () => {
			const index = this.nativeSubscriptions.indexOf(subscription);
			if (index < 0) return;
			this.nativeSubscriptions.splice(index, 1);
			subscription.remove();
		};
	}

	getSnapshot(): TelephonySnapshot {
		return {
			clientStatus: this.clientStatus,
			selectedAccountId: this.configuration?.account.id,
			sessions: [...this.sessions.values()].map((session) => session.snapshot),
			revision: this.revision,
		};
	}

	subscribe(listener: TelephonySnapshotListener): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => this.listeners.delete(listener);
	}

	subscribeToErrors(listener: TelephonyErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/** @internal Sends through the selected transport after session confirmation. */
	async sendSessionDtmf(session: JsSipSession, tones: string): Promise<void> {
		const transport = this.configuration?.dtmfTransport ??
			(["android", "ios"].includes(Platform.OS) ? "RFC2833" : "INFO");
		const context = this.errorContext(session);
		logDtmf("Submitting tone sequence", context, {
			toneCount: tones.replace(/,/g, "").length,
			transport,
		});
		if (transport === "INFO") {
			session.rtcSession.sendDTMF(tones, { transportType: JsSIP.C.DTMF_TRANSPORT.INFO });
			return;
		}
		try {
			if (Platform.OS !== "android" && Platform.OS !== "ios")
				throw new Error("The native RTP DTMF bridge is only available on Android and iOS");
			const rtpModule = Platform.OS === "ios"
				? NativeModules.ExpoCallKitRtpDtmf
				: ExpoCallKitTelecomModule;
			const senders = session.rtcSession.connection?.getSenders() as unknown as
				{ id: string; track?: { kind: string }; _peerConnectionId?: number }[] | undefined;
			const sender = senders?.find((candidate) => candidate.track?.kind === "audio");
			if (!sender || !Number.isInteger(sender._peerConnectionId))
				throw new Error("React Native WebRTC audio sender is unavailable for RTP DTMF");
			if (typeof rtpModule?.sendRtpDtmf !== "function")
				throw new Error(`RTP DTMF requires rebuilding the ${Platform.OS === "ios" ? "iOS" : "Android"} app with the updated native module`);
			const result = await rtpModule.sendRtpDtmf(sender._peerConnectionId, sender.id, tones);
			if (result?.cancelled) return;
			if (result?.nativeQueueDrained) {
				logDtmf("Native RTP queue drained; screen-independent progress is logged in the iOS device console", context);
				return;
			}
			logDtmf("Native WebRTC accepted RTP tone sequence", context);
			if (typeof rtpModule.getRtpDtmfState === "function") {
				this.runAsync(
					"sendDtmf",
					() => this.monitorRtpDtmf(session, sender._peerConnectionId!, sender.id, rtpModule),
					context
				);
			} else {
				logDtmf("Queue progress unavailable: rebuild app for native diagnostics", context);
			}
		} catch (error) {
			logDtmf("RTP tone sequence rejected", context, { message: errorMessage(error) });
			throw error;
		}
	}

	sessionDidChange(): void {
		this.emitSnapshot();
	}

	/** @internal Validate again after the audio await; native end/timeout can race it. */
	async answerIncomingMedia(session: JsSipSession): Promise<void> {
		const nativeCallId = session.snapshot.nativeCallId;
		if (session.rtcSession.isEnded() || session.rtcSession.isEstablished() || this.answeringNativeIds.has(nativeCallId)) return;
		this.answeringNativeIds.add(nativeCallId);
		await this.synchronizeCallKitAudio();
		const requestId = this.pendingAnswerRequest.get(nativeCallId);
		const valid = Platform.OS !== "ios" || (requestId &&
			await ExpoCallKitTelecomModule.validateIncomingSipCall(nativeCallId, session.id, requestId));
		if (!valid || session.rtcSession.isEnded()) {
			await this.clearPendingAnswer(nativeCallId);
			await session.terminate();
			await reportCallEnded(nativeCallId, "failed");
			return;
		}
		session.rtcSession.answer({ ...AUDIO_OPTIONS, pcConfig: { iceServers: this.configuration?.iceServers } });
	}

	private logAudioEngineState(reason: string): void {
		if (Platform.OS !== "ios") return;
		console.info("[JsSipTelephonyEngine Audio] Engine state", {
			reason,
			availability: AudioDeviceModule.getEngineAvailability(),
			isEngineRunning: AudioDeviceModule.isEngineRunning(),
			isRecording: AudioDeviceModule.isRecording(),
			isPlaying: AudioDeviceModule.isPlaying(),
		});
	}

	private async monitorRtpDtmf(
		session: JsSipSession,
		peerConnectionId: number,
		senderId: string,
		rtpModule: {
			getRtpDtmfState: (peerConnectionId: number, senderId: string) => Promise<{
				remainingSymbols: number;
				canInsert: boolean;
				audioTrackEnabled: boolean;
				durationMs: number;
				interToneGapMs: number;
			}>
		}
	): Promise<void> {
		const context = this.errorContext(session);
		let previousRemaining: number | undefined;
		let lastProgressAt = Date.now();
		while (!this.closed && !session.rtcSession.isEnded()) {
			let state: {
				remainingSymbols: number;
				canInsert: boolean;
				audioTrackEnabled: boolean;
				durationMs: number;
				interToneGapMs: number;
			};
			try {
				state = await rtpModule.getRtpDtmfState(peerConnectionId, senderId);
			} catch (error) {
				if (this.closed || session.rtcSession.isEnded()) break;
				throw error;
			}
			if (this.closed || session.rtcSession.isEnded()) break;
			if (state.remainingSymbols !== previousRemaining) {
				logDtmf("Native RTP queue progress", context, state);
				previousRemaining = state.remainingSymbols;
				lastProgressAt = Date.now();
			}
			if (state.remainingSymbols === 0) {
				// Buffer removal means handed to the RTP provider, not acknowledged by the IVR.
				logDtmf("Native RTP queue drained", context);
				return;
			}
			if (!state.canInsert)
				throw new Error(`Native RTP sender became unavailable with ${state.remainingSymbols} symbols remaining`);
			if (Date.now() - lastProgressAt >= 10_000)
				throw new Error(`Native RTP DTMF queue stalled for 10 seconds with ${state.remainingSymbols} symbols remaining`);
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
		}
		logDtmf("Native RTP queue monitoring stopped: call ended or engine closed", context);
	}

	private bindUa(ua: JsSIP.UA): void {
		ua.on("connected", () => {
			this.setClientStatus(TelephonyClientStatus.CONNECTED);
			for (const recovery of this.recoveries.values()) recovery.handleSignalingTransportConnected();
		});
		ua.on("registered", () => {
			this.setClientStatus(TelephonyClientStatus.CONNECTED);
			for (const recovery of this.recoveries.values()) recovery.handleSignalingTransportConnected();
		});
		ua.on("disconnected", (event) => {
			const expected =
					  this.clientStatus === TelephonyClientStatus.DISCONNECTING;
			const connecting = this.clientStatus === TelephonyClientStatus.CONNECTING;
			if (!expected && !this.closed) {
				for (const recovery of this.recoveries.values()) recovery.handleSignalingTransportDisconnected();
			}
			this.setClientStatus(TelephonyClientStatus.RECOVERING);
			if (!expected && !connecting) {
				this.emitError(
					"transport",
					sipFailureError("SIP transport disconnected", event),
					{}
				);
			}
		});
		ua.on("unregistered", () =>
			this.setClientStatus(TelephonyClientStatus.DISCONNECTED)
		);
		ua.on("registrationFailed", (event) => {
			const connecting = this.clientStatus === TelephonyClientStatus.CONNECTING;
			this.setClientStatus(TelephonyClientStatus.RECOVERING);
			if (!connecting) {
				this.emitError(
					"registration",
					sipFailureError("SIP registration failed", event),
					{}
				);
			}
		});
		ua.on("newRTCSession", (event: RTCSessionEvent) => {
			if (event.session.direction !== "incoming") return;
			const sipCallId =
					  (event.request as typeof event.request & { call_id?: string })
						  .call_id || event.session.id;
			this.runAsync("reportIncomingCall", () => this.onRtcSession(event), {
				sipCallId,
			});
		});
	}

	private onRtcSession(event: RTCSessionEvent): Promise<void> {
		const result = this.incomingQueue.then(() => this.admitRtcSession(event));
		this.incomingQueue = result.catch(() => undefined);
		return result;
	}

	private async admitRtcSession(event: RTCSessionEvent): Promise<void> {
		const sipCallId = (event.request as typeof event.request & { call_id?: string }).call_id || event.session.id;
		if (event.session.isEnded()) return;
		const existing = this.sessions.get(sipCallId);
		if (existing) {
			if (existing.rtcSession !== event.session) event.session.terminate({ status_code: 480 });
			return;
		}
		const identity = event.session.remote_identity;
		const handle = (identity?.uri?.user && decodeSipUser(identity.uri.user)) || identity?.toString() || "unknown";
		let nativeCallId: string | undefined;
		try {
			if (Platform.OS === "ios") {
				const admission = await ExpoCallKitTelecomModule.claimIncomingSipCall(sipCallId, handle, this.configuration?.account.id);
				console.info("[JsSipTelephonyEngine] Incoming SIP admission", { sipCallId, ...admission });
				if (admission.decision === "reject") {
					if (admission.reason === "expired" && admission.nativeCallId) {
						await this.clearPendingAnswer(admission.nativeCallId);
						await reportCallEnded(admission.nativeCallId, "unanswered");
					}
					if (!event.session.isEnded()) event.session.terminate({ status_code: 480 });
					return;
				}
				nativeCallId = admission.nativeCallId;
			} else {
				const nativeSessions = await getCallSessions();
				nativeCallId = nativeSessions.find((session) =>
					session.origin === "incoming" && session.status !== "ended" &&
					session.incomingCallEvent?.serverCallId === sipCallId && !this.sessionsByNativeId.has(session.id)
				)?.id;
			}
			if (event.session.isEnded()) {
				if (nativeCallId) await reportCallEnded(nativeCallId, "remoteEnded");
				return;
			}
			if (!nativeCallId) {
				nativeCallId = await reportIncomingCall({
					eventId: `sip:${sipCallId}`, serverCallId: sipCallId,
					caller: { id: handle, phoneNumber: handle, displayName: identity?.display_name || handle },
					hasVideo: false,
				});
				if (Platform.OS === "ios" && nativeCallId) {
					const admission = await ExpoCallKitTelecomModule.claimIncomingSipCall(sipCallId, handle, this.configuration?.account.id);
					if (admission.decision !== "matched" || admission.nativeCallId !== nativeCallId) {
						await reportCallEnded(nativeCallId, "failed");
						if (!event.session.isEnded()) event.session.terminate({ status_code: 480 });
						return;
					}
				}
			}
			const valid = nativeCallId && (Platform.OS !== "ios" ||
				await ExpoCallKitTelecomModule.validateIncomingSipCall(nativeCallId, sipCallId, null));
			if (!valid || event.session.isEnded()) {
				if (!event.session.isEnded()) event.session.terminate({ status_code: 480 });
				if (nativeCallId) await reportCallEnded(nativeCallId, "unanswered");
				return;
			}
			this.attachSession(event.session, nativeCallId!, sipCallId, "incoming");
		} catch (error) {
			if (!event.session.isEnded()) event.session.terminate({ status_code: 480 });
			if (nativeCallId) await reportCallEnded(nativeCallId, "failed").catch(() => undefined);
			throw error;
		}
	}

	private async clearPendingAnswer(nativeCallId: string): Promise<void> {
		const requestId = this.pendingAnswerRequest.get(nativeCallId);
		this.pendingAnswerRequest.delete(nativeCallId);
		this.answeringNativeIds.delete(nativeCallId);
		if (requestId) await failIncomingCallConnected(nativeCallId, requestId);
	}

	private attachSession(
		rtcSession: RTCSession,
		nativeCallId: string,
		sipCallId: string,
		direction: Direction,
		pendingTones?: string
	): JsSipSession {
		const existing = this.sessions.get(sipCallId);
		if (existing) return existing;
		const session = new JsSipSession(
			this,
			rtcSession,
			nativeCallId,
			sipCallId,
			direction
		);
		let dtmfTimer: ReturnType<typeof setTimeout> | undefined;
		let cancelNativeDtmf: (() => void) | undefined;
		const cancelPendingDtmf = (reason: string) => {
			if (pendingTones !== undefined || dtmfTimer !== undefined || cancelNativeDtmf) {
				logDtmf("Cancelled automatic tones", this.errorContext(session), { reason });
			}
			pendingTones = undefined;
			if (dtmfTimer !== undefined) clearTimeout(dtmfTimer);
			dtmfTimer = undefined;
			cancelNativeDtmf?.();
			cancelNativeDtmf = undefined;
		};
		if (pendingTones !== undefined) {
			logDtmf("Waiting for call confirmation", this.errorContext(session), {
				toneCount: pendingTones.replace(/,/g, "").length,
			});
		}
		this.sessions.set(session.id, session);
		this.sessionsByNativeId.set(nativeCallId, session);
		const logRecovery = (event: string, details: Record<string, unknown> = {}) => {
			console.info("[JsSipTelephonyEngine Recovery]", {
				timestamp: new Date().toISOString(), ...this.errorContext(session), event, ...details,
				isMuted: session.snapshot.isMuted, isOnHold: session.snapshot.isOnHold,
				platform: Platform.OS, nativeAudioActive: getAudioSession().isActive,
				...(Platform.OS === "ios" ? {
					audioAvailability: AudioDeviceModule.getEngineAvailability(),
					audioEngineRunning: AudioDeviceModule.isEngineRunning(),
					audioRecording: AudioDeviceModule.isRecording(),
					audioPlaying: AudioDeviceModule.isPlaying(),
				} : {}),
			});
		};
		const recovery = new SessionRecovery(
			rtcSession,
			() => !this.closed && this.clientStatus !== TelephonyClientStatus.DISCONNECTING &&
				this.networkPathAvailable && this.ua?.isConnected() === true,
			logRecovery,
			(error) => this.emitError("mediaNegotiation", error, this.errorContext(session))
		);
		this.recoveries.set(session.id, recovery);
		const recordTermination = (event?: EndEvent) => {
			recovery.dispose();
			this.recoveries.delete(session.id);
			const termination = sessionTermination(event);
			logRecovery("session-terminated", termination);
			return termination.reason;
		};
		rtcSession.on("progress", () =>
			session.update({ status: TelephonySessionStatus.RINGING })
		);
		rtcSession.on("confirmed", () => {
			if (rtcSession.isEnded()) return;
			// Consume before notifying listeners so confirmation cannot send twice.
			const tones = pendingTones;
			pendingTones = undefined;
			this.runAsync(
				"confirmSession",
				() => this.confirmSession(session),
				this.errorContext(session)
			);
			if (tones !== undefined && !rtcSession.isEnded()) {
				if (Platform.OS === "ios" && this.configuration?.dtmfTransport !== "INFO") {
					const rtpModule = NativeModules.ExpoCallKitRtpDtmf;
					const sender = session.rtcSession.connection?.getSenders().find((candidate) => candidate.track?.kind === "audio") as unknown as
						{ id: string; _peerConnectionId?: number } | undefined;
					this.runAsync("sendDtmf", async () => {
						if (!sender || !Number.isInteger(sender._peerConnectionId) || typeof rtpModule?.scheduleRtpDtmf !== "function")
							throw new Error("Screen-independent RTP DTMF requires rebuilding iOS with the updated native bridge and an active audio sender");
						cancelNativeDtmf = () => this.runAsync("sendDtmf", async () => {
							await rtpModule.cancelRtpDtmf(sender._peerConnectionId, sender.id);
						}, this.errorContext(session));
						logDtmf("Handing automatic tones to native iOS scheduler", this.errorContext(session), { delayMs: INVITE_DTMF_DELAY_MS });
						const result = await rtpModule.scheduleRtpDtmf(sender._peerConnectionId, sender.id, tones.toUpperCase(), INVITE_DTMF_DELAY_MS, nativeCallId);
						cancelNativeDtmf = undefined;
						logDtmf(result?.cancelled ? "Native automatic tones cancelled" : "Native RTP queue drained", this.errorContext(session));
					}, this.errorContext(session));
					return;
				}
				const scheduledAt = Date.now();
				logDtmf("Scheduled automatic tones after confirmation", this.errorContext(session), {
					delayMs: INVITE_DTMF_DELAY_MS,
				});
				dtmfTimer = setTimeout(() => {
					dtmfTimer = undefined;
					if (rtcSession.isEnded() || this.closed) {
						logDtmf("Skipped automatic tones: call ended or engine closed", this.errorContext(session));
						return;
					}
					logDtmf("Automatic tone delay elapsed", this.errorContext(session), {
						elapsedMs: Date.now() - scheduledAt,
					});
					this.runAsync(
						"sendDtmf",
						() => session.dtmf(tones),
						this.errorContext(session)
					);
				}, INVITE_DTMF_DELAY_MS);
			}
		});
		rtcSession.on("hold", () =>
			session.update({ isOnHold: true, status: TelephonySessionStatus.ON_HOLD })
		);
		rtcSession.on("unhold", () =>
			session.update({ isOnHold: false, status: TelephonySessionStatus.ACTIVE })
		);
		rtcSession.on("newDTMF", (event: IncomingDTMFEvent | OutgoingDTMFEvent) => {
			if (event.originator !== "local") return;
			logDtmf("Sending individual SIP INFO tone", this.errorContext(session), {
				durationMs: event.dtmf.duration,
			});
			event.dtmf.once("succeeded", (result: {
				response?: { status_code?: number; reason_phrase?: string };
			}) => {
				logDtmf("SIP INFO tone acknowledged", this.errorContext(session), {
					statusCode: result.response?.status_code,
					reason: result.response?.reason_phrase,
				});
			});
			event.dtmf.once("failed", (failure: SipFailureEvent) =>
				this.emitError(
					"sendDtmf",
					sipFailureError("SIP DTMF failed", failure),
					this.errorContext(session)
				)
			);
		});
		rtcSession.on("muted", () => session.update({ isMuted: true }));
		rtcSession.on("unmuted", () => session.update({ isMuted: false }));
		rtcSession.on("failed", (event: EndEvent) => {
			const reason = recordTermination(event);
			// JsSIP emits failed(local, CANCELED) for an ordinary hang-up before answer.
			const cancelled = event.originator === "local" && event.cause === JsSIP.C.causes.CANCELED;
			cancelPendingDtmf(cancelled ? "Call cancelled" : "Call failed");
			if (!cancelled) {
				this.emitError(
					"sessionFailed",
					sipFailureError("SIP session failed", event),
					this.errorContext(session)
				);
			}
			this.runAsync(
				"terminateSession",
				() => this.terminateSession(session, reason),
				this.errorContext(session)
			);
		});
		const reportMediaFailure = (operation: string, cause: unknown) =>
			this.emitError(
				"mediaNegotiation",
				mediaFailureError(operation, cause),
				this.errorContext(session)
			);
		rtcSession.on("getusermediafailed", (cause: unknown) =>
			reportMediaFailure("Microphone capture failed", cause)
		);
		rtcSession.on("peerconnection:createofferfailed", (cause: unknown) =>
			reportMediaFailure("WebRTC offer creation failed", cause)
		);
		rtcSession.on(
			"peerconnection:setlocaldescriptionfailed",
			(cause: unknown) =>
				reportMediaFailure("WebRTC local description failed", cause)
		);
		rtcSession.on(
			"peerconnection:setremotedescriptionfailed",
			(cause: unknown) =>
				reportMediaFailure("WebRTC remote description failed", cause)
		);
		rtcSession.on("ended", (event: EndEvent) => {
			const reason = recordTermination(event);
			if (reason === "failed") {
				this.emitError("sessionFailed", sipFailureError("SIP session ended", event ?? {}), this.errorContext(session));
			}
			cancelPendingDtmf("Call ended");
			this.runAsync(
				"terminateSession",
				() => this.terminateSession(session, reason),
				this.errorContext(session)
			);
		});
		this.emitSnapshot();
		if (
			direction === "incoming" &&
			this.pendingAnswerRequest.has(nativeCallId)
		) {
			this.runAsync(
				"acceptSession",
				() => this.answerFromSystem(nativeCallId, this.pendingAnswerRequest.get(nativeCallId)!),
				this.errorContext(session)
			);
		}
		return session;
	}

	private async confirmSession(session: JsSipSession): Promise<void> {
		this.logAudioEngineState("SIP confirmed");
		session.update({
			status: TelephonySessionStatus.ACTIVE,
			connectedAt: Date.now(),
		});
		const nativeCallId = session.snapshot.nativeCallId;
		const requestId = this.pendingAnswerRequest.get(nativeCallId);
		if (requestId) {
			this.pendingAnswerRequest.delete(nativeCallId);
			if (Platform.OS === "ios") {
				const fulfilled = await ExpoCallKitTelecomModule.fulfillIncomingCallAnswered(requestId);
				if (!fulfilled) {
					await session.terminate();
					await reportCallEnded(nativeCallId, "failed");
				}
			} else {
				await fulfillIncomingCallConnected(requestId);
			}
		} else if (session.snapshot.direction === "outgoing") {
			await reportOutgoingCallConnected(nativeCallId);
		}
	}

	private disposeRecoveries(): void {
		for (const recovery of this.recoveries.values()) recovery.dispose();
		this.recoveries.clear();
	}

	private async terminateSession(
		session: JsSipSession,
		reason: ReturnType<typeof sessionTermination>["reason"]
	): Promise<void> {
		if (!this.sessions.has(session.id)) return;
		session.update({
			status: TelephonySessionStatus.TERMINATED,
			endedAt: Date.now(),
		});
		try {
			await this.clearPendingAnswer(session.snapshot.nativeCallId);
			if (reason === "localEnded") {
				if (!this.nativeEnding.has(session.snapshot.nativeCallId)) await endCall(session.snapshot.nativeCallId);
			} else {
				await reportCallEnded(session.snapshot.nativeCallId, reason);
			}
		} finally {
			this.sessions.delete(session.id);
			this.sessionsByNativeId.delete(session.snapshot.nativeCallId);
			this.nativeEnding.delete(session.snapshot.nativeCallId);
			this.emitSnapshot();
		}
	}

	private async answerFromSystem(
		nativeCallId: string,
		requestId: string
	): Promise<void> {
		if (!requestId) return;
		if (Platform.OS === "ios" && !await ExpoCallKitTelecomModule.validateIncomingSipCall(nativeCallId, null, requestId)) {
			await failIncomingCallConnected(nativeCallId, requestId);
			return;
		}
		this.pendingAnswerRequest.set(nativeCallId, requestId);
		const session = this.sessionsByNativeId.get(nativeCallId);
		if (!session) return;
		try {
			await session.answerMedia();
		} catch (error) {
			await this.clearPendingAnswer(nativeCallId);
			await session.terminate();
			await reportCallEnded(nativeCallId, "failed");
			throw error;
		}
	}

	private async endFromSystem(nativeCallId: string): Promise<void> {
		const session = this.sessionsByNativeId.get(nativeCallId);
		if (session) this.nativeEnding.add(nativeCallId);
		await this.clearPendingAnswer(nativeCallId);
		await session?.terminate();
	}

	private async callFromSystem(
		handle: string,
		nativeCallId?: string
	): Promise<void> {
		if (!nativeCallId) {
			await this.invite(handle);
			return;
		}
		if (!this.ua || !this.isConnected()) {
			await reportCallEnded(nativeCallId, "failed");
			return;
		}
		try {
			await this.synchronizeCallKitAudio();
			const rtcSession = this.ua.call(handle, { ...AUDIO_OPTIONS, pcConfig: { iceServers: this.configuration?.iceServers } });
			this.attachSession(rtcSession, nativeCallId, rtcSession.id, "outgoing");
		} catch (error) {
			await reportCallEnded(nativeCallId, "failed");
			throw error;
		}
	}

	private muteFromSystem(nativeCallId: string, muted: boolean): void {
		const session = this.sessionsByNativeId.get(nativeCallId);
		if (!session || session.snapshot.isMuted === muted) return;
		if (muted) session.rtcSession.mute({ audio: true, video: false });
		else session.rtcSession.unmute({ audio: true, video: false });
		session.update({ isMuted: muted });
	}

	private holdFromSystem(nativeCallId: string, held: boolean): void {
		const session = this.sessionsByNativeId.get(nativeCallId);
		if (!session || session.snapshot.isOnHold === held) return;
		if (held) session.rtcSession.hold();
		else session.rtcSession.unhold();
		session.update({
			isOnHold: held,
			status: held
				? TelephonySessionStatus.ON_HOLD
				: TelephonySessionStatus.ACTIVE,
		});
	}

	private setClientStatus(status: TelephonyClientStatus): void {
		if (this.clientStatus === status) return;
		this.clientStatus = status;
		this.emitSnapshot();
	}

	private emitSnapshot(): void {
		this.revision += 1;
		const snapshot = this.getSnapshot();
		this.listeners.forEach((listener) => listener(snapshot));
	}

	private runAsync(
		operation: TelephonyErrorOperation,
		task: () => Promise<unknown>,
		context: ErrorContext = {}
	): void {
		void task().catch((error: unknown) =>
			this.emitError(operation, error, context)
		);
	}

	private runSync(
		operation: TelephonyErrorOperation,
		task: () => unknown,
		context: ErrorContext = {}
	): void {
		try {
			task();
		} catch (error) {
			this.emitError(operation, error, context);
		}
	}

	private errorContext(session: JsSipSession): ErrorContext {
		return {
			nativeCallId: session.snapshot.nativeCallId,
			sipCallId: session.snapshot.sipCallId,
		};
	}

	private emitError(
		operation: TelephonyErrorOperation,
		cause: unknown,
		context: ErrorContext
	): void {
		// JsSIP DTMF request timeouts/transport errors can fail the entire session,
		// so log event-driven failures even when no error subscriber is installed.
		if (this.errorListeners.size === 0) {
			const isDtmf = operation === "sendDtmf" || operation === "sendDtmfFromSystem";
			console.error(
				isDtmf
					? "[JsSipTelephonyEngine DTMF] Send failed"
					: "[JsSipTelephonyEngine] Operation failed",
				{
					timestamp: new Date().toISOString(),
					...context,
					operation,
					message: errorMessage(cause),
					nativeCode: errorCode(cause),
				}
			);
		}
		const permissions = requiredPermissions(cause);
		const error: TelephonyError = {
			code: permissions.length > 0 ? "missing_permissions" : "operation_failed",
			nativeCode: errorCode(cause),
			message: errorMessage(cause),
			operation,
			requiredPermissions: permissions,
			...context,
			cause,
		};
		this.errorListeners.forEach((listener) => {
			try {
				listener(error);
			} catch {
				// A consumer listener must not prevent other listeners from receiving the error.
			}
		});
	}
}
