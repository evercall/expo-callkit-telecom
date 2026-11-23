import type { RTCSession, RTCSessionEventMap, SDPEvent, TerminateOptions } from "jssip/lib/RTCSession";
import { MAX_ICE_RESTART_ATTEMPTS, MEDIA_VERIFICATION_TIMEOUT_MS, NEGOTIATION_TIMEOUT_MS, RECOVERY_POLL_INTERVAL_MS, RECOVERY_TIMEOUT_MS, RECOVERY_TRIGGER_DEBOUNCE_MS, TRANSIENT_GRACE_MS } from '../constants';

type RecoveryTrigger = "ice-failed" | "ice-disconnected" | "transport-loss" | "network-change";

type RecoveryPhase = "waiting" | "negotiating" | "verifying";
type RecoveryLogger = (event: string, details?: Record<string, unknown>) => void;
type WebRtcStatsEntry = { type: string; id: string; [key: string]: unknown };
type RtpCounters = { packets: number; bytes: number };
type AudioRtpSample = {
	received: Map<string, RtpCounters>;
	sent: Map<string, RtpCounters>;
};

type SdpIceCredentials = {
	usernameFragments: string;
	passwords: string;
};

const parseSdpIceCredentials = (sdp: string): SdpIceCredentials => {
	const readAttributeValues = (attribute: string) =>
		[...sdp.matchAll(new RegExp(`^a=ice-${attribute}:(.+)$`, "gm"))]
		.map((match) => match[1].trim()).sort().join("\n");
	return {
		usernameFragments: readAttributeValues("ufrag"),
		passwords: readAttributeValues("pwd"),
	};
};

const haveIceCredentialsChanged = (
	previousCredentials: SdpIceCredentials | undefined,
	restartOfferSdp: string
): boolean | null => {
	if (!previousCredentials?.usernameFragments || !previousCredentials.passwords) return null;
	const restartCredentials = parseSdpIceCredentials(restartOfferSdp);
	if (!restartCredentials.usernameFragments || !restartCredentials.passwords) return null;
	return previousCredentials.usernameFragments !== restartCredentials.usernameFragments &&
		previousCredentials.passwords !== restartCredentials.passwords;
};

const getRtpCounterDelta = (currentCounters: Map<string, RtpCounters>, previousCounters: Map<string, RtpCounters>) => {
	let packets = 0;
	let bytes = 0;
	for (const [id, value] of currentCounters) {
		const baseline = previousCounters.get(id);
		if (!baseline) continue;
		packets += Math.max(0, value.packets - baseline.packets);
		bytes += Math.max(0, value.bytes - baseline.bytes);
	}
	return { packets, bytes };
};

/**
 * JsSIP 3.10.1 installs its ICE-failed listener before emitting peerconnection.
 * Guard its precise public terminate() request instead of trying to reorder
 * anonymous listeners or changing private peer-connection state. Transport
 * errors are deferred only with stable SDP and a disconnected transport (the
 * UA notifies transactions before its disconnected event). No prototype
 * or dependency is patched. Capability checks admit compatible session/PC
 * APIs; only the precise recoverable termination requests are intercepted.
 *
 * renegotiate()'s own terminal failure is deliberately NOT suppressed: JsSIP
 * has no public rejection/rollback hook, and a rejected offer can leave the PC
 * in have-local-offer. JsSIP handles one 491 retry itself. Other rejection,
 * transaction timeout and dialog failures retain their actual terminal cause.
 */
export class SessionRecovery {
	private peerConnection?: RTCSession["connection"];
	private readonly originalTerminateSession: RTCSession["terminate"];
	private readonly terminateWithRecovery: RTCSession["terminate"];
	private readonly sessionEventListeners: [keyof RTCSessionEventMap, (...args: any[]) => void][] = [];
	private recoveryPollTimer?: ReturnType<typeof setTimeout>;
	private recoveryDeadlineTimer?: ReturnType<typeof setTimeout>;
	private isDisposed = false;
	private isRecovering = false;
	private hasExhaustedRecovery = false;
	private isSignalingTransportDisconnected = false;
	private recoveryPhase: RecoveryPhase = "waiting";
	private recoveryStartedAtMs = 0;
	private recoveryPhaseStartedAtMs = 0;
	private recoveryAttemptCount = 0;
	private shouldRestartIce = false;
	private needsAnotherIceRestart = false;
	private shouldVerifyMediaAfterUnhold = false;
	private sdpIceCredentialsBeforeRestart?: SdpIceCredentials;
	private restartOfferChangedIceCredentials: boolean | null = null;
	private hasObservedRestartOffer = false;
	private hasObservedRestartAnswer = false;
	private previousRtpSample?: AudioRtpSample;
	private recoveryGeneration = 0;
	private lastDeferralReason?: string;
	private readonly hasRequiredSessionApis: boolean;

	constructor(
		private readonly rtcSession: RTCSession,
		private readonly isSignalingReady: () => boolean,
		private readonly logRecoveryEvent: RecoveryLogger,
		private readonly reportRecoveryFailure: (error: Error) => void
	) {
		const requiredSessionMethods = ["terminate", "renegotiate", "isEnded", "isEstablished", "isOnHold", "isMuted", "on", "removeListener"] as const;
		const missingSessionMethods = requiredSessionMethods.filter((method) => typeof rtcSession[method] !== "function");
		this.hasRequiredSessionApis = missingSessionMethods.length === 0;
		this.originalTerminateSession = rtcSession.terminate;
		this.terminateWithRecovery = (options?: TerminateOptions) => {
			const iceTimeout = options?.cause === "RTP Timeout" &&
				options.status_code === 408 && options.reason_phrase === "RTP Timeout";
			const transportError = options?.cause === "Connection Error" &&
				options.status_code === 500 && options.reason_phrase === "Connection Error" &&
				rtcSession.connection?.signalingState === "stable" && !this.isSignalingReady();
			if ((iceTimeout || transportError) && this.canRecoverSession() && !this.hasExhaustedRecovery) {
				// Runs synchronously from JsSIP's FIRST listener, before it closes
				// the PC. Ordinary local hangup and all other causes pass through.
				if (transportError) this.handleSignalingTransportDisconnected();
				else this.requestRecovery("ice-failed");
				return;
			}
			this.logRecoveryEvent("local-termination-request", {
				cause: options?.cause ?? "Terminated", reasonHeaderCode: options?.status_code,
			});
			this.originalTerminateSession.call(rtcSession, options);
		};
		if (this.hasRequiredSessionApis) rtcSession.terminate = this.terminateWithRecovery;
		else {
			this.logRecoveryEvent("recovery-unavailable", { missingSessionMethods });
			return;
		}

		this.addSessionListener("peerconnection", ({ peerconnection }) => this.observePeerConnection(peerconnection));
		this.addSessionListener("sdp", (event: SDPEvent) => this.handleSessionSdp(event));
		this.addSessionListener("unhold", () => this.verifyMediaAfterUnhold());
		// End/failed disposal is synchronous in the engine, before native work.
		this.observePeerConnection(rtcSession.connection);
	}

	handleSignalingTransportDisconnected = (): void => {
		if (!this.canRecoverSession() || this.isSignalingTransportDisconnected) return;
		this.isSignalingTransportDisconnected = true;
		this.logRecoveryEvent("transport-disconnected");
		this.requestRecovery("transport-loss");
	};

	handleSignalingTransportConnected = (): void => {
		if (this.isDisposed) return;
		if (this.isSignalingTransportDisconnected) this.logRecoveryEvent("transport-reconnected");
		this.isSignalingTransportDisconnected = false;
		if (this.isRecovering) this.scheduleRecoveryPoll(RECOVERY_TRIGGER_DEBOUNCE_MS);
	};

	requestRecovery = (trigger: RecoveryTrigger): void => {
		if (!this.canRecoverSession() || this.hasExhaustedRecovery) return;
		const forced = trigger !== "ice-disconnected";
		if (!this.isRecovering) {
			this.shouldVerifyMediaAfterUnhold = false;
			this.startRecovery();
		} else if (forced && (trigger === "network-change" || trigger === "transport-loss") &&
			this.recoveryPhase !== "waiting") this.needsAnotherIceRestart = true;
		this.shouldRestartIce ||= forced;
		this.logRecoveryEvent("recovery-trigger", { trigger, coalesced: this.recoveryAttemptCount > 0, attempt: this.recoveryAttemptCount });
		this.scheduleRecoveryPoll(trigger === "ice-disconnected" ? TRANSIENT_GRACE_MS : RECOVERY_TRIGGER_DEBOUNCE_MS);
	};

	dispose = (): void => {
		if (this.isDisposed) return;
		if (this.isRecovering) this.logRecoveryEvent("recovery-cancelled", { attempt: this.recoveryAttemptCount });
		this.isDisposed = true;
		this.cancelPendingRecoveryWork();
		this.removePeerConnectionListeners();
		for (const [event, listener] of this.sessionEventListeners) this.rtcSession.removeListener(event, listener);
		this.sessionEventListeners.length = 0;
		if (this.rtcSession.terminate === this.terminateWithRecovery) this.rtcSession.terminate = this.originalTerminateSession;
	};

	private canRecoverSession = (): boolean =>
		this.hasRequiredSessionApis && this.peerConnection !== undefined && !this.isDisposed && !this.rtcSession.isEnded() &&
		this.rtcSession.isEstablished();

	private addSessionListener = (event: keyof RTCSessionEventMap, callback: (...args: any[]) => void): void => {
		this.rtcSession.on(event, callback);
		this.sessionEventListeners.push([event, callback]);
	};

	private observePeerConnection = (peerConnection?: RTCSession["connection"]): void => {
		if (!peerConnection || peerConnection === this.peerConnection) return;
		this.removePeerConnectionListeners();
		this.peerConnection = undefined;
		const requiredPeerConnectionMethods = ["addEventListener", "removeEventListener", "getStats"] as const;
		const missingPeerConnectionMethods = requiredPeerConnectionMethods.filter((method) => typeof peerConnection[method] !== "function");
		if (missingPeerConnectionMethods.length > 0) {
			this.logRecoveryEvent("recovery-unavailable", { missingPeerConnectionMethods });
			return;
		}
		this.peerConnection = peerConnection;
		for (const event of ["iceconnectionstatechange", "connectionstatechange", "signalingstatechange"]) {
			peerConnection.addEventListener(event, this.handlePeerConnectionStateChange);
		}
		this.logPeerConnectionState("peerconnection-observed");
	};

	private removePeerConnectionListeners = (): void => {
		for (const event of ["iceconnectionstatechange", "connectionstatechange", "signalingstatechange"]) {
			this.peerConnection?.removeEventListener(event, this.handlePeerConnectionStateChange);
		}
	};

	private logPeerConnectionState = (event: string): void => {
		this.logRecoveryEvent(event, {
			iceState: this.peerConnection?.iceConnectionState,
			connectionState: this.peerConnection?.connectionState,
			signalingState: this.peerConnection?.signalingState,
		});
	};

	private handlePeerConnectionStateChange = (): void => {
		if (this.isDisposed) return;
		this.logPeerConnectionState("peerconnection-state");
		if (this.peerConnection?.iceConnectionState === "failed" || this.peerConnection?.connectionState === "failed") {
			this.requestRecovery("ice-failed");
			return;
		}
		if (this.peerConnection?.iceConnectionState === "disconnected" || this.peerConnection?.connectionState === "disconnected") {
			this.requestRecovery("ice-disconnected");
			return;
		}
		if (this.isRecovering) this.scheduleRecoveryPoll(RECOVERY_POLL_INTERVAL_MS);
	};

	private startRecovery = (): void => {
		this.isRecovering = true;
		this.recoveryStartedAtMs = Date.now();
		this.recoveryPhaseStartedAtMs = this.recoveryStartedAtMs;
		this.recoveryPhase = "waiting";
		this.recoveryAttemptCount = 0;
		this.shouldRestartIce = false;
		this.needsAnotherIceRestart = false;
		this.previousRtpSample = undefined;
		this.lastDeferralReason = undefined;
		this.recoveryGeneration++;
		this.recoveryDeadlineTimer = setTimeout(() => this.failRecovery("recovery-deadline"), RECOVERY_TIMEOUT_MS);
	};

	private isPeerConnectionConnected = (): boolean =>
		(this.peerConnection?.iceConnectionState === "connected" || this.peerConnection?.iceConnectionState === "completed") &&
		this.peerConnection?.connectionState === "connected";

	private scheduleRecoveryPoll = (delay: number): void => {
		if (!this.isRecovering || this.isDisposed || this.recoveryPollTimer !== undefined) return;
		this.recoveryPollTimer = setTimeout(() => {
			this.recoveryPollTimer = undefined;
			this.advanceRecovery().catch(() => this.failRecovery("recovery-operation-failed"));
		}, delay);
	};

	private deferRecovery = (reason: string): void => {
		if (this.lastDeferralReason !== reason) this.logRecoveryEvent("recovery-deferred", { reason, attempt: this.recoveryAttemptCount });
		this.lastDeferralReason = reason;
		this.scheduleRecoveryPoll(RECOVERY_POLL_INTERVAL_MS);
	};

	private advanceRecovery = async (): Promise<void> => {
		if (!this.isRecovering || !this.canRecoverSession()) return;
		if (this.recoveryPhase === "negotiating") {
			if (Date.now() - this.recoveryPhaseStartedAtMs >= NEGOTIATION_TIMEOUT_MS) {
				// Never overlap a still-outstanding SIP offer with another attempt.
				this.failRecovery("negotiation-timeout");
				return;
			}
			this.scheduleRecoveryPoll(RECOVERY_POLL_INTERVAL_MS);
			return;
		}
		if (this.recoveryPhase === "verifying") {
			await this.verifyMediaFlow();
			return;
		}
		if (!this.shouldRestartIce && this.isPeerConnectionConnected()) {
			this.completeRecovery("transient-disconnection-cleared", false);
			return;
		}
		if (!this.shouldRestartIce && Date.now() - this.recoveryStartedAtMs < TRANSIENT_GRACE_MS) {
			this.deferRecovery("transient-ice-grace");
			return;
		}
		if (!this.isSignalingReady()) {
			this.deferRecovery("signaling-unavailable");
			return;
		}
		if (!this.peerConnection || this.peerConnection.signalingState !== "stable") {
			this.deferRecovery("signaling-not-stable");
			return;
		}
		// 3.10.1 declares isReadyToReOffer() but only implements the private
		// version. Feature-detect the public method; renegotiate()'s boolean
		// result is the authoritative public admission check on this version.
		if (typeof this.rtcSession.isReadyToReOffer === "function" && !this.rtcSession.isReadyToReOffer()) {
			this.deferRecovery("jssip-not-ready");
			return;
		}
		if (this.recoveryAttemptCount >= MAX_ICE_RESTART_ATTEMPTS) {
			this.failRecovery("attempt-limit");
			return;
		}
		this.recoveryAttemptCount++;
		this.recoveryPhase = "negotiating";
		this.recoveryPhaseStartedAtMs = Date.now();
		this.lastDeferralReason = undefined;
		const localSdpBeforeRestart = this.peerConnection.localDescription?.sdp;
		this.sdpIceCredentialsBeforeRestart = localSdpBeforeRestart ? parseSdpIceCredentials(localSdpBeforeRestart) : undefined;
		this.restartOfferChangedIceCredentials = null;
		this.hasObservedRestartOffer = false;
		this.hasObservedRestartAnswer = false;
		this.needsAnotherIceRestart = false;
		this.previousRtpSample = undefined;
		const recoveryGeneration = this.recoveryGeneration;
		const attempt = this.recoveryAttemptCount;
		this.logRecoveryEvent("recovery-attempt", { attempt: this.recoveryAttemptCount, elapsedMs: Date.now() - this.recoveryStartedAtMs });
		const accepted = this.rtcSession.renegotiate({ rtcOfferConstraints: { iceRestart: true } }, () => {
			if (this.isDisposed || !this.isRecovering || recoveryGeneration !== this.recoveryGeneration ||
				attempt !== this.recoveryAttemptCount || this.recoveryPhase !== "negotiating") return;
			this.recoveryPhase = "verifying";
			this.recoveryPhaseStartedAtMs = Date.now();
			this.logRecoveryEvent("negotiation-accepted", {
				attempt: this.recoveryAttemptCount, iceCredentialsChanged: this.restartOfferChangedIceCredentials,
				offerObserved: this.hasObservedRestartOffer, answerObserved: this.hasObservedRestartAnswer,
			});
			this.scheduleRecoveryPoll(RECOVERY_POLL_INTERVAL_MS);
		});
		if (!accepted && this.isRecovering && !this.isDisposed) {
			this.recoveryAttemptCount--;
			this.recoveryPhase = "waiting";
			this.deferRecovery("jssip-offer-busy");
			return;
		}
		this.scheduleRecoveryPoll(RECOVERY_POLL_INTERVAL_MS);
	};

	private handleSessionSdp = (event: SDPEvent): void => {
		if (!this.isRecovering || this.recoveryPhase !== "negotiating") return;
		if (event.originator === "local" && event.type === "offer") {
			this.hasObservedRestartOffer = true;
			this.restartOfferChangedIceCredentials = haveIceCredentialsChanged(this.sdpIceCredentialsBeforeRestart, event.sdp);
			this.logRecoveryEvent("restart-offer", { attempt: this.recoveryAttemptCount, iceCredentialsChanged: this.restartOfferChangedIceCredentials });
		}
		if (this.hasObservedRestartOffer && event.originator === "remote" && event.type === "answer") {
			this.hasObservedRestartAnswer = true;
			this.logRecoveryEvent("restart-answer", { attempt: this.recoveryAttemptCount });
		}
	};

	private collectAudioRtpSample = async (): Promise<AudioRtpSample | undefined> => {
		const peerConnection = this.peerConnection;
		const recoveryGeneration = this.recoveryGeneration;
		if (!peerConnection || typeof peerConnection.getStats !== "function") return undefined;
		const report = await peerConnection.getStats().catch(() => undefined);
		if (!report || this.isDisposed || !this.isRecovering || recoveryGeneration !== this.recoveryGeneration) return undefined;
		const rows: WebRtcStatsEntry[] = [];
		report.forEach((row: WebRtcStatsEntry) => rows.push(row));
		const result: AudioRtpSample = { received: new Map(), sent: new Map() };
		for (const row of rows) {
			if (row.kind !== "audio" && row.mediaType !== "audio") continue;
			if (row.type === "inbound-rtp") result.received.set(row.id, {
				packets: Number(row.packetsReceived) || 0, bytes: Number(row.bytesReceived) || 0,
			});
			if (row.type === "outbound-rtp") result.sent.set(row.id, {
				packets: Number(row.packetsSent) || 0, bytes: Number(row.bytesSent) || 0,
			});
		}
		const transport = rows.find((row) => row.type === "transport" && row.selectedCandidatePairId);
		const selected = rows.find((row) => row.type === "candidate-pair" && row.id === transport?.selectedCandidatePairId);
		const pair = selected ?? rows.find((row) => row.type === "candidate-pair" &&
			row.state === "succeeded" && (row.selected === true || row.nominated === true));
		const local = rows.find((row) => row.id === pair?.localCandidateId);
		const remote = rows.find((row) => row.id === pair?.remoteCandidateId);
		const candidateType = (value: unknown) =>
			["host", "srflx", "prflx", "relay"].includes(String(value)) ? value : "unknown";
		const protocol = (value: unknown) => ["udp", "tcp"].includes(String(value)) ? value : "unknown";
		const received = this.previousRtpSample && getRtpCounterDelta(result.received, this.previousRtpSample.received);
		const sent = this.previousRtpSample && getRtpCounterDelta(result.sent, this.previousRtpSample.sent);
		this.logRecoveryEvent("media-sample", {
			attempt: this.recoveryAttemptCount,
			localCandidateType: candidateType(local?.candidateType),
			remoteCandidateType: candidateType(remote?.candidateType),
			localProtocol: protocol(local?.protocol), remoteProtocol: protocol(remote?.protocol),
			receivedDelta: received ?? null, sentDelta: sent ?? null,
		});
		return result;
	};

	private verifyMediaFlow = async (): Promise<void> => {
		const recoveryGeneration = this.recoveryGeneration;
		const audioRtpSample = await this.collectAudioRtpSample();
		if (this.isDisposed || !this.isRecovering || recoveryGeneration !== this.recoveryGeneration) return;
		const hold = this.rtcSession.isOnHold();
		const muted = this.rtcSession.isMuted().audio === true;
		const received = audioRtpSample && this.previousRtpSample && getRtpCounterDelta(audioRtpSample.received, this.previousRtpSample.received);
		const sent = audioRtpSample && this.previousRtpSample && getRtpCounterDelta(audioRtpSample.sent, this.previousRtpSample.sent);
		this.previousRtpSample = audioRtpSample;
		const restartExchanged = this.shouldVerifyMediaAfterUnhold ||
			(this.hasObservedRestartOffer && this.hasObservedRestartAnswer && this.restartOfferChangedIceCredentials === true);
		if (restartExchanged && this.isPeerConnectionConnected() && this.isSignalingReady() && !this.needsAnotherIceRestart) {
			if (hold.local || hold.remote) {
				this.shouldVerifyMediaAfterUnhold = true;
				this.completeRecovery("transport-restored-media-deferred-while-held", false);
				return;
			}
			if (received && received.packets > 0 && received.bytes > 0 &&
				(muted || (sent && sent.packets > 0 && sent.bytes > 0))) {
				this.shouldVerifyMediaAfterUnhold = false;
				this.completeRecovery("recovery-completed", true);
				return;
			}
		}
		if (this.needsAnotherIceRestart || Date.now() - this.recoveryPhaseStartedAtMs >= MEDIA_VERIFICATION_TIMEOUT_MS) {
			this.logRecoveryEvent("media-not-verified", { attempt: this.recoveryAttemptCount, muted, held: hold.local || hold.remote });
			this.shouldVerifyMediaAfterUnhold = false;
			this.shouldRestartIce = true;
			this.recoveryPhase = "waiting";
			this.previousRtpSample = undefined;
		}
		this.scheduleRecoveryPoll(RECOVERY_POLL_INTERVAL_MS);
	};

	private verifyMediaAfterUnhold = (): void => {
		if (!this.shouldVerifyMediaAfterUnhold || !this.canRecoverSession() || this.isRecovering) return;
		this.startRecovery();
		this.recoveryPhase = "verifying";
		this.logRecoveryEvent("verifying-media-after-unhold");
		this.scheduleRecoveryPoll(RECOVERY_POLL_INTERVAL_MS);
	};

	private cancelPendingRecoveryWork = (): void => {
		if (this.recoveryPollTimer !== undefined) clearTimeout(this.recoveryPollTimer);
		if (this.recoveryDeadlineTimer !== undefined) clearTimeout(this.recoveryDeadlineTimer);
		this.recoveryPollTimer = undefined;
		this.recoveryDeadlineTimer = undefined;
		this.isRecovering = false;
		this.recoveryGeneration++;
		this.previousRtpSample = undefined;
		this.sdpIceCredentialsBeforeRestart = undefined;
	};

	private completeRecovery = (event: string, mediaVerified: boolean): void => {
		this.logRecoveryEvent(event, { attempt: this.recoveryAttemptCount, elapsedMs: Date.now() - this.recoveryStartedAtMs, mediaVerified });
		this.cancelPendingRecoveryWork();
	};

	private failRecovery = (reason: string): void => {
		if (!this.isRecovering || this.isDisposed) return;
		this.hasExhaustedRecovery = true;
		this.logRecoveryEvent("recovery-failed", { reason, attempt: this.recoveryAttemptCount, elapsedMs: Date.now() - this.recoveryStartedAtMs });
		this.cancelPendingRecoveryWork();
		this.reportRecoveryFailure(new Error(`Network handover recovery failed: ${reason}`));
		if (!this.rtcSession.isEnded()) this.originalTerminateSession.call(this.rtcSession, {
			cause: "RTP Timeout", status_code: 408, reason_phrase: "Network recovery exhausted",
		});
	};
}
