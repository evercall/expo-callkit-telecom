import { type AudioDevice, type AudioDeviceDirection, TelephonySession, TelephonySessionSnapshot, TelephonySessionStatus } from './TelephonyEngine.types';
import type { EndEvent, RTCSession } from 'jssip/lib/RTCSession';
import { answerCall, setHeld, setMuted } from '../Calls';
import * as JsSIP from 'jssip';
import ExpoCallKitTelecomModule from '../ExpoCallKitTelecomModule';
import { JsSipTelephonyEngine } from './JsSipTelephonyEngine';
import { Direction } from '../Calls.types';
import { decodeSipUser, validateDtmfTones } from '../utils/sip';
import { sipFailureError } from '../utils/errors';
import { TRANSFER_TIMEOUT_MS } from '../constants';

// JsSIP 3.10 returns a ReferSubscriber (or false), although its declarations
// incorrectly declare RTCSession.refer() as void. Only use its public emitter API.
type ReferSubscription = {
	removeListener(event: string, listener: () => void): unknown;
};

export class JsSipSession implements TelephonySession {
	private current: TelephonySessionSnapshot;
	private transferInProgress = false;
	private dtmfTones = '';

	constructor(
		private readonly engine: JsSipTelephonyEngine,
		readonly rtcSession: RTCSession,
		nativeCallId: string,
		sipCallId: string,
		direction: Direction
	) {
		const identity = rtcSession.remote_identity;
		const phoneNumber =
				  (identity?.uri?.user && decodeSipUser(identity.uri.user)) ||
				  identity?.toString() ||
				  "unknown";
		this.current = {
			id: sipCallId,
			nativeCallId,
			sipCallId,
			direction,
			status:
				direction === "incoming"
					? TelephonySessionStatus.RINGING
					: TelephonySessionStatus.TRYING,
			remoteIdentity: {
				phoneNumber,
				displayName: identity?.display_name || phoneNumber,
			},
			startedAt: rtcSession.start_time?.getTime() ?? Date.now(),
			isMuted: false,
			isOnHold: false,
		};
	}

	get id(): string {
		return this.current.id;
	}

	get snapshot(): TelephonySessionSnapshot {
		return {
			...this.current,
			remoteIdentity: { ...this.current.remoteIdentity },
		};
	}

	get dtmfTonesSent(): string {
		return this.dtmfTones;
	}

	update(patch: Partial<TelephonySessionSnapshot>): void {
		this.current = { ...this.current, ...patch };
		this.engine.sessionDidChange();
	}

	async accept(): Promise<void> {
		if (this.current.direction === "incoming") {
			if (!this.rtcSession.isEstablished())
				await answerCall(this.current.nativeCallId);
			return;
		}
		await this.answerMedia();
	}

	/** Answers SIP after the native answer action, without requesting that action again. */
	async answerMedia(): Promise<void> {
		await this.engine.answerIncomingMedia(this);
	}

	async accepted(): Promise<boolean> {
		if (this.rtcSession.isEnded())
			throw new Error("Call ended before it could be accepted");
		if (this.current.connectedAt !== undefined) return true;

		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.rtcSession.removeListener("confirmed", onConfirmed);
				this.rtcSession.removeListener("failed", onFailed);
				this.rtcSession.removeListener("ended", onEnded);
			};
			const onConfirmed = () => {
				cleanup();
				resolve(true);
			};
			const onFailed = (event: EndEvent) => {
				cleanup();
				reject(sipFailureError("Call failed before it could be accepted", event));
			};
			const onEnded = () => {
				cleanup();
				reject(new Error("Call ended before it could be accepted"));
			};
			this.rtcSession.once("confirmed", onConfirmed);
			this.rtcSession.once("failed", onFailed);
			this.rtcSession.once("ended", onEnded);
		});
	}

	async reject(): Promise<void> {
		if (!this.rtcSession.isEnded())
			this.rtcSession.terminate({ status_code: 486 });
	}

	async cancel(): Promise<void> {
		if (!this.rtcSession.isEnded()) this.rtcSession.terminate();
	}

	async terminate(): Promise<void> {
		if (!this.rtcSession.isEnded()) this.rtcSession.terminate();
	}

	async hold(): Promise<boolean> {
		const changed = this.rtcSession.hold();
		if (changed) {
			this.update({ isOnHold: true, status: TelephonySessionStatus.ON_HOLD });
			await setHeld(this.current.nativeCallId, true);
		}
		return changed;
	}

	async unhold(): Promise<boolean> {
		const changed = this.rtcSession.unhold();
		if (changed) {
			this.update({ isOnHold: false, status: TelephonySessionStatus.ACTIVE });
			await setHeld(this.current.nativeCallId, false);
		}
		return changed;
	}

	async blindTransfer(target: string): Promise<boolean> {
		if (typeof target !== "string" || !JsSIP.URI.parse(target)) {
			throw new TypeError("Transfer target must be a valid SIP URI");
		}
		return this.transfer(target);
	}

	async attendedTransfer(target: { id: string }): Promise<boolean> {
		const targetSession = this.engine.getSession(target.id);
		if (!(targetSession instanceof JsSipSession)) throw new Error("Session B not found");
		if (targetSession === this) throw new Error("Cannot transfer a session to itself");
		if (targetSession.rtcSession.isEnded() || !targetSession.rtcSession.isEstablished()) {
			throw new Error("Transfer target session must be established");
		}
		return this.transfer(targetSession.rtcSession.remote_identity.uri.toString(), targetSession);
	}

	async setMuted(muted: boolean): Promise<void> {
		if (muted) this.rtcSession.mute({ audio: true, video: false });
		else this.rtcSession.unmute({ audio: true, video: false });
		this.update({ isMuted: muted });
		await setMuted(this.current.nativeCallId, muted);
	}

	async setInput(device: AudioDevice): Promise<void> {
		await this.setAudioDevice("input", device);
	}

	async setOutput(device: AudioDevice): Promise<void> {
		await this.setAudioDevice("output", device);
	}

	async dtmf(tones: string): Promise<void> {
		validateDtmfTones(tones);
		await this.accepted();
		if (this.rtcSession.isEnded())
			throw new Error("Cannot send DTMF on an ended call");
		await this.engine.sendSessionDtmf(this, tones.toUpperCase());
		this.dtmfTones += tones;
	}

	private async transfer(target: string, replaces?: JsSipSession): Promise<boolean> {
		if (this.engine.getSession(this.id) !== this || this.rtcSession.isEnded()) {
			throw new Error("Cannot transfer an ended or removed call");
		}
		if (!this.rtcSession.isEstablished()) throw new Error("Transfer source session must be established");
		if (this.transferInProgress) throw new Error("A transfer is already in progress for this call");
		this.transferInProgress = true;
		try {
			const success = await this.requestTransfer(target, replaces);
			if (success) await this.terminate();
			return success;
		} finally {
			this.transferInProgress = false;
		}
	}

	private requestTransfer(target: string, replaces?: JsSipSession): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			let settled = false;
			let subscription: ReferSubscription | false | undefined;
			const cleanup = () => {
				clearTimeout(timeout);
				this.rtcSession.removeListener("ended", onFailure);
				this.rtcSession.removeListener("failed", onFailure);
				replaces?.rtcSession.removeListener("ended", onFailure);
				replaces?.rtcSession.removeListener("failed", onFailure);
				if (subscription) {
					subscription.removeListener("requestSucceeded", onSuccess);
					subscription.removeListener("requestFailed", onFailure);
				}
			};
			const finish = (success: boolean) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(success);
			};
			const onSuccess = () => finish(true);
			const onFailure = () => finish(false);
			const timeout = setTimeout(onFailure, TRANSFER_TIMEOUT_MS);
			this.rtcSession.once("ended", onFailure);
			this.rtcSession.once("failed", onFailure);
			replaces?.rtcSession.once("ended", onFailure);
			replaces?.rtcSession.once("failed", onFailure);
			const sendRefer = async () => {
				// JsSIP 3.10 returns a ReferSubscriber (or false), although its declarations
				// incorrectly declare RTCSession.refer() as void. Only use its public emitter API.
				subscription = this.rtcSession.refer(target, {
					replaces: replaces?.rtcSession,
					eventHandlers: { requestSucceeded: onSuccess, requestFailed: onFailure },
				}) as unknown as ReferSubscription | false;
				// Cover a synchronous callback during sendRefer before the handle exists.
				if (settled) cleanup();
				if (subscription === false) onFailure();
			};
			sendRefer().catch((error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			});
		});
	}

	private async setAudioDevice(direction: AudioDeviceDirection, device: AudioDevice): Promise<void> {
		if (this.rtcSession.isEnded()) throw new Error("Cannot change audio devices on an ended call");
		if (device.direction !== direction) throw new Error(`Expected an ${direction} audio device`);
		if (!this.engine.getAudioDevices(direction).some((candidate) => candidate.id === device.id)) {
			throw new Error("Audio device is no longer available");
		}
		await ExpoCallKitTelecomModule.setAudioDevice(this.current.nativeCallId, direction, device.id);
	}
}
