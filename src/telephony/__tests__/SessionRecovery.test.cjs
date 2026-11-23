// node --test src/telephony/__tests__/SessionRecovery.test.cjs
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const flush = () => new Promise((done) => setImmediate(done));
const sdp = (tag) => [
	"v=0", "o=- 1 1 IN IP4 0.0.0.0", "s=-", "t=0 0",
	"m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0",
	"a=rtpmap:111 opus/48000/2", "a=sendrecv",
	`a=ice-ufrag:private-ufrag-${tag}`, `a=ice-pwd:private-pwd-${tag}`, "",
].join("\r\n");

function load(filename, globals = {}) {
	const module = { exports: {} };
	const compiled = ts.transpileModule(readFileSync(resolve(__dirname, filename), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	vm.runInNewContext(compiled.outputText, { exports: module.exports, module, ...globals });
	return module.exports;
}

class Peer extends EventEmitter {
	iceConnectionState = "connected";
	connectionState = "connected";
	signalingState = "stable";
	localDescription = { type: "offer", sdp: sdp("old") };
	inbound = 100;
	outbound = 100;
	advanceStats = true;
	offerOptions = [];
	getSenders = () => [];
	getReceivers = () => [];
	addEventListener = (event, callback) => this.on(event, callback);
	removeEventListener = (event, callback) => this.off(event, callback);

	async getStats() {
		if (this.advanceStats) {
			this.inbound += 10;
			this.outbound += 10;
		}
		return new Map([
			["in", { id: "in", type: "inbound-rtp", kind: "audio", packetsReceived: this.inbound, bytesReceived: this.inbound * 20 }],
			["out", { id: "out", type: "outbound-rtp", kind: "audio", packetsSent: this.outbound, bytesSent: this.outbound * 20 }],
			["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
			["pair", { id: "pair", type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote" }],
			["local", { id: "local", type: "local-candidate", candidateType: "srflx", protocol: "udp", address: "PRIVATE-IP" }],
			["remote", { id: "remote", type: "remote-candidate", candidateType: "relay", protocol: "udp", address: "PRIVATE-IP" }],
		]);
	}

	createOffer = async (options) => {
		this.offerOptions.push(options);
		return { type: "offer", sdp: sdp("new") };
	};
	setLocalDescription = async (description) => {
		this.localDescription = description;
		this.signalingState = "have-local-offer";
		// JsSIP's real gathering-complete path is exercised in the integration test.
		setImmediate(() => {
			this.iceGatheringState = "complete";
			this.emit("icegatheringstatechange", {});
		});
	};
	setRemoteDescription = async (description) => {
		this.remoteDescription = description;
		this.signalingState = "stable";
		this.iceConnectionState = "connected";
	};
	close = () => {
		this.connectionState = "closed";
		this.iceConnectionState = "closed";
	};
}

class Session extends EventEmitter {
	connection = new Peer();
	ended = false;
	held = false;
	remoteHeld = false;
	muted = false;
	ready = true;
	offers = [];
	terminations = [];
	callbacks = [];
	isEstablished = () => !this.ended;
	isEnded = () => this.ended;
	isOnHold = () => ({ local: this.held, remote: this.remoteHeld });
	isMuted = () => ({ audio: this.muted });
	isReadyToReOffer = () => this.ready;
	terminate = (options) => {
		this.terminations.push(options);
		this.ended = true;
		this.emit("ended", { originator: "local", cause: options?.cause ?? "Terminated" });
	};
	renegotiate = (options, done) => {
		if (!this.ready) return false;
		this.offers.push(options);
		this.callbacks.push(done);
		return true;
	};

	answer(changed = true) {
		const body = changed ? sdp(this.offers.length) : this.connection.localDescription.sdp;
		this.emit("sdp", { originator: "local", type: "offer", sdp: body });
		this.connection.localDescription = { type: "offer", sdp: body };
		this.emit("sdp", { originator: "remote", type: "answer", sdp: sdp("remote") });
		this.connection.iceConnectionState = "connected";
		this.connection.connectionState = "connected";
		this.callbacks.at(-1)();
	}
}

function setup(session = new Session()) {
	let now = 0;
	let timerId = 0;
	let online = true;
	const timers = new Map();
	const logs = [];
	const failures = [];
	const globals = {
		Date: class extends Date {
			static now() {
				return now;
			}
		},
		setTimeout: (callback, delay) => {
			const id = ++timerId;
			timers.set(id, { callback, due: now + delay });
			return id;
		},
		clearTimeout: (id) => timers.delete(id),
	};
	const { SessionRecovery } = load("../SessionRecovery.ts", globals);
	const recovery = new SessionRecovery(session, () => online,
		(event, details) => logs.push({ event, ...details }), (error) => failures.push(error));
	session.on("ended", () => recovery.dispose());
	session.on("failed", () => recovery.dispose());
	const advance = async (ms) => {
		const target = now + ms;
		for (; ;) {
			const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
			if (!next || next[1].due > target) break;
			now = next[1].due;
			timers.delete(next[0]);
			next[1].callback();
			await flush();
		}
		now = target;
		await flush();
	};
	return {
		recovery, session, timers, logs, failures, advance, setOnline: (value) => {
			online = value;
		}
	};
}

test("coalesces network/transport/ICE triggers; waits for live signaling and verifies RTP", async () => {
	const state = setup();
	const { recovery, session } = state;
	const peer = session.connection;
	state.setOnline(false);
	recovery.handleSignalingTransportDisconnected();
	recovery.handleSignalingTransportDisconnected();
	recovery.requestRecovery("network-change");
	peer.iceConnectionState = "disconnected";
	peer.emit("iceconnectionstatechange");
	await state.advance(3000);
	assert.equal(session.offers.length, 0);
	state.setOnline(true);
	recovery.handleSignalingTransportConnected();
	recovery.handleSignalingTransportConnected();
	await state.advance(500);
	assert.equal(session.offers.length, 1);
	assert.equal(session.offers[0].rtcOfferConstraints.iceRestart, true);
	session.answer();
	assert.equal(state.logs.some((row) => row.event === "recovery-completed"), false);
	await state.advance(1500);
	assert.equal(session.connection, peer);
	assert.equal(session.ended, false);
	assert.equal(state.logs.filter((row) => row.event === "recovery-completed").length, 1);
	assert.equal(state.timers.size, 0);
	assert.equal(JSON.stringify(state.logs).includes("private-"), false);
	assert.equal(JSON.stringify(state.logs).includes("PRIVATE-IP"), false);
	assert.equal(state.logs.find((row) => row.event === "media-sample").localCandidateType, "srflx");
	recovery.dispose();
});

test("ICE disconnected can clear during grace without sending an offer", async () => {
	const state = setup();
	state.session.connection.iceConnectionState = "disconnected";
	state.session.connection.emit("iceconnectionstatechange");
	await state.advance(800);
	state.session.connection.iceConnectionState = "connected";
	state.session.connection.emit("iceconnectionstatechange");
	await state.advance(1500);
	assert.equal(state.session.offers.length, 0);
	assert.ok(state.logs.some((row) => row.event === "transient-disconnection-cleared"));
	state.recovery.dispose();
});

test("offer admission is deferred for unstable signaling, public readiness, and renegotiate(false)", async () => {
	const state = setup();
	state.session.connection.signalingState = "have-remote-offer";
	state.recovery.requestRecovery("network-change");
	await state.advance(1500);
	assert.equal(state.session.offers.length, 0);
	state.session.connection.signalingState = "stable";
	state.session.ready = false;
	await state.advance(1500);
	assert.equal(state.session.offers.length, 0);
	// Match installed JsSIP's missing public method despite its declaration.
	state.session.isReadyToReOffer = undefined;
	await state.advance(500);
	assert.ok(state.logs.some((row) => row.reason === "jssip-offer-busy"));
	state.session.ready = true;
	await state.advance(500);
	assert.equal(state.session.offers.length, 1);
	state.recovery.dispose();
});

test("held recovery preserves hold/mute, defers RTP proof, then verifies after unhold", async () => {
	const state = setup();
	state.session.held = true;
	state.session.muted = true;
	state.session.connection.advanceStats = false;
	state.recovery.requestRecovery("network-change");
	await state.advance(500);
	state.session.answer();
	await state.advance(1000);
	assert.equal(state.session.held, true);
	assert.equal(state.session.muted, true);
	assert.ok(state.logs.some((row) => row.event === "transport-restored-media-deferred-while-held" && row.mediaVerified === false));
	assert.equal(state.timers.size, 0);
	state.session.held = false;
	state.session.connection.getStats = async () => new Map([
		["in", { id: "in", type: "inbound-rtp", kind: "audio", packetsReceived: ++state.session.connection.inbound, bytesReceived: state.session.connection.inbound * 20 }],
	]);
	state.session.emit("unhold");
	await state.advance(2000);
	assert.ok(state.logs.some((row) => row.event === "recovery-completed"));
	assert.equal(state.session.offers.length, 1);
	assert.equal(state.session.muted, true);
	state.recovery.dispose();
});

for (const fault of ["stalled-rtp", "unchanged-credentials", "missing-answer"]) {
	test(`bounds recovery attempts for ${fault} instead of equating acceptance with recovery`, async () => {
		const state = setup();
		state.session.connection.advanceStats = fault !== "stalled-rtp";
		state.recovery.requestRecovery("network-change");
		for (let attempt = 1; attempt <= 3; attempt++) {
			await state.advance(1000);
			assert.equal(state.session.offers.length, attempt);
			if (fault === "missing-answer") state.session.callbacks.at(-1)();
			else state.session.answer(fault !== "unchanged-credentials");
			await state.advance(6000);
		}
		await state.advance(1000);
		assert.equal(state.session.offers.length, 3);
		assert.equal(state.failures.length, 1);
		assert.equal(state.session.terminations.length, 1);
		assert.equal(state.session.terminations[0].cause, "RTP Timeout");
		assert.equal(state.logs.some((row) => row.event === "recovery-completed"), false);
		assert.equal(state.timers.size, 0);
	});
}

test("rapid changes during an offer coalesce into one further offer", async () => {
	const state = setup();
	state.recovery.requestRecovery("network-change");
	await state.advance(500);
	for (let count = 0; count < 20; count++) state.recovery.requestRecovery("network-change");
	await state.advance(1000);
	assert.equal(state.session.offers.length, 1);
	state.session.answer();
	await state.advance(1000);
	assert.equal(state.session.offers.length, 2);
	state.session.answer();
	await state.advance(1500);
	assert.equal(state.session.offers.length, 2);
	assert.ok(state.logs.some((row) => row.event === "recovery-completed"));
	state.recovery.dispose();
});

test("hangup cancels timers/listeners; a late answer cannot restart work", async () => {
	const state = setup();
	const original = state.recovery.originalTerminateSession;
	state.recovery.requestRecovery("network-change");
	await state.advance(500);
	state.session.terminate();
	state.session.callbacks.at(-1)();
	await state.advance(60_000);
	assert.equal(state.session.offers.length, 1);
	assert.equal(state.session.terminate, original);
	assert.equal(state.session.listenerCount("sdp"), 0);
	assert.equal(state.session.connection.listenerCount("iceconnectionstatechange"), 0);
	assert.equal(state.timers.size, 0);
	assert.equal(state.failures.length, 0);
});

test("dispose during signaling outage and unresolved getStats cancels all work", async () => {
	for (const stalledStats of [false, true]) {
		const state = setup();
		if (stalledStats) {
			state.recovery.requestRecovery("network-change");
			await state.advance(500);
			state.session.answer();
			state.session.connection.getStats = () => new Promise(() => {
			});
		} else {
			state.setOnline(false);
			state.recovery.handleSignalingTransportDisconnected();
		}
		await state.advance(1000);
		state.recovery.dispose();
		await state.advance(60_000);
		assert.equal(state.failures.length, 0);
		assert.equal(state.timers.size, 0);
		assert.equal(state.session.listenerCount("sdp"), 0);
	}
});

test("offline deadline and outstanding-offer timeout terminate once without overlapping offers", async () => {
	for (const online of [false, true]) {
		const state = setup();
		state.setOnline(online);
		state.recovery.requestRecovery("network-change");
		await state.advance(60_000);
		assert.equal(state.session.offers.length, online ? 1 : 0);
		assert.equal(state.failures.length, 1);
		assert.equal(state.session.terminations.length, 1);
		assert.equal(state.timers.size, 0);
	}
});

for (const missingApi of ["renegotiate", "terminate", "isEstablished", "isMuted"]) {
	test(`missing required API ${missingApi} leaves normal termination untouched`, async () => {
		const session = new Session();
		session[missingApi] = undefined;
		const originalTerminate = session.terminate;
		const state = setup(session);
		state.recovery.requestRecovery("network-change");
		await state.advance(1000);
		assert.equal(session.terminate, originalTerminate);
		assert.equal(session.offers.length, 0);
		assert.equal(state.timers.size, 0);
		assert.ok(state.logs.some((row) => row.event === "recovery-unavailable" && row.missingSessionMethods.includes(missingApi)));
		state.recovery.dispose();
	});
}

test("installed JsSIP's first ICE listener is intercepted before it can close the PC", async () => {
	const RTCSession = require("jssip/lib/RTCSession");
	const savedPeer = global.RTCPeerConnection;
	global.RTCPeerConnection = Peer;
	try {
		const session = new RTCSession({
			configuration: {}, destroyRTCSession() {
			}
		});
		session._status = RTCSession.C.STATUS_CONFIRMED;
		session._dialog = {
			terminate() {
			}
		};
		session._createRTCConnection({});
		const state = setup(session);
		session.connection.iceConnectionState = "failed";
		session.connection.emit("iceconnectionstatechange");
		assert.equal(session.isEnded(), false);
		assert.notEqual(session.connection.connectionState, "closed");
		assert.ok(state.logs.some((row) => row.trigger === "ice-failed"));
		state.recovery.dispose();
		session.sendRequest = () => {
		};
		session.connection.emit("iceconnectionstatechange");
		assert.equal(session.isEnded(), true);
		assert.equal(session.connection.connectionState, "closed");
	} finally {
		global.RTCPeerConnection = savedPeer;
	}
});

test("installed JsSIP sends restart SDP in a re-INVITE and applies the answer on the same PC", async () => {
	const RTCSession = require("jssip/lib/RTCSession");
	const savedPeer = global.RTCPeerConnection;
	const savedDescription = global.RTCSessionDescription;
	global.RTCPeerConnection = Peer;
	global.RTCSessionDescription = class {
		constructor(value) {
			Object.assign(this, value);
		}
	};
	try {
		const session = new RTCSession({
			configuration: {}, destroyRTCSession() {
			}
		});
		session._status = RTCSession.C.STATUS_CONFIRMED;
		session._dialog = {
			terminate() {
			}
		};
		session._createRTCConnection({});
		session._localHold = true;
		session._audioMuted = true;
		const peer = session.connection;
		const requests = [];
		session.sendRequest = (method, options) => requests.push({ method, options });
		const state = setup(session);
		state.recovery.requestRecovery("network-change");
		await state.advance(500);
		await flush();
		const invite = requests.find((request) => request.method === "INVITE");
		assert.ok(invite);
		assert.equal(peer.offerOptions[0].iceRestart, true);
		assert.match(invite.options.body, /a=ice-ufrag:private-ufrag-new/);
		assert.match(invite.options.body, /a=sendonly/);
		invite.options.eventHandlers.onSuccessResponse({
			body: sdp("answer"), hasHeader: () => true, getHeader: () => "application/sdp",
		});
		await flush();
		assert.equal(peer.remoteDescription.type, "answer");
		assert.equal(peer.remoteDescription.sdp, sdp("answer"));
		assert.equal(session.connection, peer);
		assert.equal(session.isOnHold().local, true);
		assert.equal(session.isMuted().audio, true);
		assert.ok(state.logs.some((row) => row.event === "negotiation-accepted" && row.iceCredentialsChanged === true));
		state.recovery.dispose();
	} finally {
		global.RTCPeerConnection = savedPeer;
		global.RTCSessionDescription = savedDescription;
	}
});

test("installed JsSIP rejection remains terminal and is never retried blindly", async () => {
	const RTCSession = require("jssip/lib/RTCSession");
	const session = new RTCSession({
		configuration: {}, destroyRTCSession() {
		}
	});
	session._status = RTCSession.C.STATUS_CONFIRMED;
	session._dialog = {
		terminate() {
		}
	};
	session._connection = new Peer();
	session._sendReinvite = ({ eventHandlers }) => eventHandlers.failed({ status_code: 488 });
	session.sendRequest = () => {
	};
	const state = setup(session);
	state.recovery.requestRecovery("network-change");
	// Installed public API's synchronous failure handler invokes guarded terminate.
	session.renegotiate({ rtcOfferConstraints: { iceRestart: true } });
	assert.equal(session.isEnded(), true);
	assert.equal(state.timers.size, 0);
	assert.equal(state.failures.length, 0);
	await state.advance(60_000);
});

const { sessionTermination } = load("../SessionTermination.ts");
const message = (method, headers = [], status_code) => ({ method, status_code, getHeaders: () => headers });
for (const [label, event, reason] of [
	["remote BYE", { originator: "remote", cause: "Terminated", message: message("BYE") }, "remoteEnded"],
	["local hangup", { originator: "local", cause: "Terminated" }, "localEnded"],
	["RTP failure", { originator: "local", cause: "RTP Timeout" }, "failed"],
	["remote-labelled NO_ACK", { originator: "remote", cause: "No ACK" }, "failed"],
	["connection failure", { originator: "local", cause: "Connection Error" }, "failed"],
	["local cancel", { originator: "local", cause: "Canceled" }, "unanswered"],
	["no answer", { originator: "remote", cause: "No Answer" }, "unanswered"],
	["rejected INVITE", { originator: "remote", cause: "Rejected", message: message("INVITE", [], 488) }, "failed"],
	["remote media failure BYE", { originator: "remote", cause: "Terminated", message: message("BYE", ['SIP;cause=408;text="private text"']) }, "failed"],
	["normal Q850 BYE", { originator: "remote", cause: "Terminated", message: message("BYE", ["Q.850;cause=16"]) }, "remoteEnded"],
	["abnormal Q850 BYE", { originator: "remote", cause: "Terminated", message: message("BYE", ["Q.850;cause=41"]) }, "failed"],
	["missing event", undefined, "failed"],
]) {
	test(`termination mapping: ${label}`, () => {
		const result = sessionTermination(event);
		assert.equal(result.reason, reason);
		assert.equal(JSON.stringify(result).includes("private text"), false);
	});
}
test("termination retains method/status/structured Reason evidence", () => {
	const result = sessionTermination({
		originator: "remote", cause: "Rejected",
		message: message("INVITE", ['SIP;text="PRIVATE";cause=488, Q.850;cause=88'], 488)
	});
	assert.equal(result.statusCode, 488);
	assert.equal(result.method, "INVITE");
	assert.equal(result.reasonHeaderPresent, true);
	assert.equal(result.reasons.length, 2);
	assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("late callback from a prior attempt cannot complete a newer negotiation", async () => {
	const state = setup();
	state.recovery.requestRecovery("network-change");
	await state.advance(500);
	const oldCallback = state.session.callbacks.at(-1);
	state.recovery.requestRecovery("network-change");
	state.session.answer();
	await state.advance(1000);
	assert.equal(state.session.offers.length, 2);
	oldCallback();
	await state.advance(1000);
	assert.equal(state.logs.filter((row) => row.event === "negotiation-accepted").length, 1);
	assert.equal(state.logs.some((row) => row.event === "recovery-completed"), false);
	state.session.answer();
	await state.advance(1500);
	assert.ok(state.logs.some((row) => row.event === "recovery-completed"));
	state.recovery.dispose();
});

test("stable established calls survive JsSIP transport-error termination before UA disconnected", async () => {
	const state = setup();
	state.setOnline(false);
	state.session.terminate({ cause: "Connection Error", status_code: 500, reason_phrase: "Connection Error" });
	assert.equal(state.session.isEnded(), false);
	state.recovery.handleSignalingTransportDisconnected();
	await state.advance(2000);
	assert.equal(state.session.offers.length, 0);
	state.setOnline(true);
	state.recovery.handleSignalingTransportConnected();
	await state.advance(500);
	assert.equal(state.session.offers.length, 1);
	state.session.answer();
	await state.advance(1500);
	assert.ok(state.logs.some((row) => row.event === "recovery-completed"));
	assert.equal(state.logs.filter((row) => row.event === "transport-disconnected").length, 1);
	state.recovery.dispose();
});

test("transport errors with an outstanding local offer remain terminal", () => {
	const state = setup();
	state.setOnline(false);
	state.session.connection.signalingState = "have-local-offer";
	state.session.terminate({ cause: "Connection Error", status_code: 500, reason_phrase: "Connection Error" });
	assert.equal(state.session.isEnded(), true);
	assert.equal(state.timers.size, 0);
});

test("Reason text cannot masquerade as a second failure code", () => {
	const result = sessionTermination({
		originator: "remote", cause: "Terminated",
		message: message("BYE", ['Q.850;cause=16;text="normal, SIP;cause=500"'])
	});
	assert.equal(result.reason, "remoteEnded");
	assert.equal(result.reasons.length, 1);
	assert.equal(result.reasons[0].cause, 16);
});

test("candidate diagnostics prefer the transport-selected pair over an earlier nominated pair", async () => {
	const state = setup();
	const peer = state.session.connection;
	const getStats = peer.getStats.bind(peer);
	peer.getStats = async () => new Map([
		["stale", { id: "stale", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "staleLocal", remoteCandidateId: "staleLocal" }],
		["staleLocal", { id: "staleLocal", type: "local-candidate", candidateType: "host", protocol: "tcp" }],
		...await getStats(),
	]);
	state.recovery.requestRecovery("network-change");
	await state.advance(500);
	state.session.answer();
	await state.advance(1500);
	const sample = state.logs.find((row) => row.event === "media-sample");
	assert.equal(sample.localCandidateType, "srflx");
	assert.equal(sample.localProtocol, "udp");
	state.recovery.dispose();
});

test("SDP credential baseline is absent until an actual local SDP is available and is cleared on disposal", async () => {
	const state = setup();
	assert.equal(state.recovery.sdpIceCredentialsBeforeRestart, undefined);
	state.recovery.requestRecovery("network-change");
	await state.advance(500);
	assert.equal(state.recovery.sdpIceCredentialsBeforeRestart.usernameFragments, "private-ufrag-old");
	assert.equal(state.recovery.sdpIceCredentialsBeforeRestart.passwords, "private-pwd-old");
	state.recovery.dispose();
	assert.equal(state.recovery.sdpIceCredentialsBeforeRestart, undefined);
});

test("missing local SDP leaves credential comparison unknown and cannot falsely prove restart", async () => {
	const state = setup();
	state.session.connection.localDescription = null;
	state.recovery.requestRecovery("network-change");
	await state.advance(500);
	assert.equal(state.recovery.sdpIceCredentialsBeforeRestart, undefined);
	state.session.answer();
	await state.advance(1500);
	assert.equal(state.logs.find((row) => row.event === "restart-offer").iceCredentialsChanged, null);
	assert.equal(state.logs.some((row) => row.event === "recovery-completed"), false);
	state.recovery.dispose();
});

test("missing peer-connection capabilities leave JsSIP's normal termination intact", () => {
	const session = new Session();
	session.connection.getStats = undefined;
	const state = setup(session);
	session.terminate({ cause: "RTP Timeout", status_code: 408, reason_phrase: "RTP Timeout" });
	assert.equal(session.ended, true);
	assert.equal(state.timers.size, 0);
	assert.ok(state.logs.some((row) => row.event === "recovery-unavailable" && row.missingPeerConnectionMethods.includes("getStats")));
});
