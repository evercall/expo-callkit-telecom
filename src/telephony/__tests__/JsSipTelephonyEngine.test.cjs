// Run with: node --test src/telephony/__tests__/JsSipTelephonyEngine.test.cjs
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadModule(filename, imports, globals = {}) {
	const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	const module = { exports: {} };
	vm.runInNewContext(compiled.outputText, {
		module, exports: module.exports, Date, setTimeout, clearTimeout, ...globals,
		require(name) {
			assert.ok(name in imports, `Unexpected import: ${name}`);
			return imports[name];
		},
	}, { filename });
	return module.exports;
}

class MockSession extends EventEmitter {
	id = "sip-call";
	direction = "outgoing";
	remote_identity = { uri: { user: "123" } };
	ended = false;
	sent = [];

	isEnded() {
		return this.ended;
	}

	sendDTMF(tones, options) {
		this.sent.push({ tones, transport: options.transportType });
	}

	finish(event) {
		this.ended = true;
		this.emit(event, { cause: "Rejected", originator: "remote" });
	}
}

function setup(platform = "ios", initiallyActive = false, engineFile = "../JsSipTelephonyEngine.ts") {
	const rtc = new MockSession();
	let now = 0;
	let timerId = 0;
	const timers = new Map();
	const logs = [];
	const globals = {
		Date: class extends Date {
			constructor(...args) {
				super(...(args.length ? args : [1000 + now]));
			}

			static now() {
				return 1000 + now;
			}
		},
		setTimeout(callback, delay) {
			const id = ++timerId;
			timers.set(id, { callback, due: now + delay });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		console: {
			info: (...args) => logs.push({ level: "info", args }),
			error: (...args) => logs.push({ level: "error", args }),
		},
	};
	const advanceTime = (elapsed) => {
		now += elapsed;
		for (const [id, timer] of [...timers]) {
			if (timer.due <= now) {
				timers.delete(id);
				timer.callback();
			}
		}
	};
	const native = {};
	let audioActive = initiallyActive;
	const audioTransitions = [];
	let transitionFailure;
	const audioDeviceModule = {
		async setEngineAvailability(availability) {
			if (transitionFailure) throw transitionFailure;
			audioTransitions.push({ ...availability });
		},
		getEngineAvailability: () => audioTransitions.at(-1),
		isEngineRunning: () => audioActive,
		isRecording: () => audioActive,
		isPlaying: () => audioActive,
	};
	const rtpSent = [];
	const nativeScheduled = [];
	const nativeCancelled = [];
	const nativeModule = {
		dtmfSchedulerVersion: 2,
		sendRtpDtmf: async (...args) => {
			rtpSent.push(args);
		},
		scheduleRtpDtmf: async (...args) => {
			nativeScheduled.push(args);
		},
		cancelRtpDtmf: async (...args) => {
			nativeCancelled.push(args);
		},
	};
	rtc.connection = { getSenders: () => [{ id: "audio-sender", track: { kind: "audio" }, _peerConnectionId: 7 }] };
	let starts = 0;
	const reportedEnds = [];
	const answerRequests = [];
	const fulfilledAnswers = [];
	const reportedConnections = [];
	const calls = {
		answerCall: async (id) => {
			answerRequests.push(id);
		},
		fulfillIncomingCallConnected: async (id) => {
			fulfilledAnswers.push(id);
		},
		startOutgoingCall: async () => {
			starts++;
			return "native-call";
		},
		reportCallEnded: async (...args) => {
			reportedEnds.push(args);
		},
		reportOutgoingCallConnected: async (id) => {
			reportedConnections.push(id);
		},
		getAudioSession: () => ({ isActive: audioActive }),
	};
	const failedAnswers = [];
	calls.failIncomingCallConnected = async (...args) => failedAnswers.push(args);
	nativeModule.validateIncomingSipCall = async () => true;
	nativeModule.fulfillIncomingCallAnswered = async (id) => {
		fulfilledAnswers.push(id);
		return true;
	};
	let newlyReported;
	nativeModule.claimIncomingSipCall = async (sipCallId) => {
		const sessions = calls.getCallSessions ? await calls.getCallSessions() : [];
		const matched = sessions.find((session) => session.origin === "incoming" && session.incomingCallEvent?.serverCallId === sipCallId);
		if (matched) return { decision: "matched", nativeCallId: matched.id };
		if (newlyReported) return { decision: "matched", nativeCallId: newlyReported };
		const report = calls.reportIncomingCall;
		calls.reportIncomingCall = async (...args) => {
			newlyReported = await report(...args);
			return newlyReported;
		};
		return { decision: "new" };
	};
	for (const name of ["addCallAnsweredListener", "addCallEndedListener",
		"addCallIntentReceivedListener", "addCallSessionRemovedListener", "addSetHeldActionListener",
		"addSetMutedActionListener", "addDTMFListener",
		"addAudioSessionActivatedListener", "addAudioSessionDeactivatedListener", "addAudioRouteChangedListener"]) {
		calls[name] = (callback) => {
			native[name] = callback;
			return {
				remove() {
				}
			};
		};
	}
	const contracts = loadModule(resolve(__dirname, "../TelephonyEngine.types.ts"), {});
	const { JsSipTelephonyEngine } = loadModule(resolve(__dirname, engineFile), {
		"@livekit/react-native-webrtc": {
			registerGlobals() {
			},
			AudioDeviceModule: audioDeviceModule,
			AudioEngineAvailability: {
				default: { isInputAvailable: true, isOutputAvailable: true },
				none: { isInputAvailable: false, isOutputAvailable: false },
			},
		},
		"react-native": { Platform: { OS: platform }, NativeModules: { ExpoCallKitRtpDtmf: nativeModule } },
		"../ExpoCallKitTelecomModule": { default: nativeModule, __esModule: true },
		jssip: { URI: require("jssip").URI, C: { DTMF_TRANSPORT: { INFO: "INFO" }, causes: { CANCELED: "Canceled" } } },
		"../Calls": calls,
		"./TelephonyEngine.types": contracts,
	}, globals);
	const engine = new JsSipTelephonyEngine();
	engine.configuration = { account: { id: "test-account" }, ...(platform === "ios" ? { dtmfTransport: "INFO" } : {}) };
	engine.ua = { isConnected: () => true, isRegistered: () => true, call: () => rtc };
	const errors = [];
	engine.subscribeToErrors((error) => errors.push(error));
	return {
		engine, rtc, native, nativeModule, rtpSent, nativeScheduled, nativeCancelled, reportedEnds, errors, logs, timers, advanceTime,
		calls, answerRequests, fulfilledAnswers, reportedConnections, failedAnswers,
		starts: () => starts, audioTransitions, audioDeviceModule,
		setAudioActive: (active) => {
			audioActive = active;
		},
		failAudioTransition: (error) => {
			transitionFailure = error;
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const listenerCounts = (rtc) => ["confirmed", "failed", "ended"].map((event) => rtc.listenerCount(event));
const uri = "sip:123@example.com";

test("invite sends tones once, five seconds after confirmation", async () => {
	const { engine, rtc, advanceTime } = setup();
	const session = await engine.invite(uri, "12,a#");
	assert.equal(session.id, rtc.id);
	rtc.emit("progress");
	await flush();
	assert.equal(rtc.sent.length, 0);
	rtc.emit("confirmed");
	await flush();
	assert.equal(rtc.sent.length, 0);
	advanceTime(4999);
	await flush();
	assert.equal(rtc.sent.length, 0);
	rtc.emit("confirmed");
	advanceTime(1);
	await flush();
	assert.deepEqual(rtc.sent, [{ tones: "12,A#", transport: "INFO" }]);
	rtc.emit("confirmed");
	await flush();
	assert.equal(rtc.sent.length, 1);
	assert.deepEqual(listenerCounts(rtc), [1, 1, 1]);
});

test("invite does not invoke session.dtmf until the post-confirmation delay", async () => {
	const { engine, rtc, advanceTime } = setup();
	const prototype = Object.getPrototypeOf(engine.attachSession(new MockSession(), "prototype-call", "prototype-sip-call", "outgoing"));
	const original = prototype.dtmf;
	const invocations = [];
	prototype.dtmf = async function (tones) {
		invocations.push(tones);
		return original.call(this, tones);
	};
	try {
		await engine.invite(uri, "123#");
		rtc.emit("progress");
		rtc.emit("accepted");
		await flush();
		assert.deepEqual(invocations, []);
		rtc.emit("confirmed");
		await flush();
		assert.deepEqual(invocations, []);
		advanceTime(5000);
		await flush();
		assert.deepEqual(invocations, ["123#"]);
		rtc.emit("confirmed");
		await flush();
		assert.deepEqual(invocations, ["123#"]);
	} finally {
		prototype.dtmf = original;
	}
});

test("invite without tones remains compatible", async () => {
	const { engine, rtc } = setup();
	await engine.invite(uri);
	rtc.emit("confirmed");
	await flush();
	assert.equal(rtc.sent.length, 0);
});

test("invalid invite tones reject before creating a native call", async () => {
	const { engine, starts } = setup();
	for (const tones of ["", "12x", "1 2", null, 123]) {
		await assert.rejects(engine.invite(uri, tones), /Invalid DTMF tones/);
	}
	assert.equal(starts(), 0);
});

for (const event of ["failed", "ended"]) {
	test(`automatic tones are discarded when call ${event} before confirmation`, async () => {
		const { engine, rtc, errors } = setup();
		await engine.invite(uri, "123#");
		rtc.finish(event);
		await flush();
		rtc.emit("confirmed");
		await flush();
		assert.equal(rtc.sent.length, 0);
		assert.ok(errors.every((error) => error.operation !== "sendDtmf"));
		assert.deepEqual(listenerCounts(rtc), [1, 1, 1]);
	});
}

test("accepted and dtmf work on a call already confirmed", async () => {
	const { engine, rtc } = setup();
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	assert.equal(await session.accepted(), true);
	await session.dtmf("ab12#");
	assert.deepEqual(rtc.sent, [{ tones: "AB12#", transport: "INFO" }]);
	assert.deepEqual(listenerCounts(rtc), [1, 1, 1]);
});

test("direct dtmf waits for confirmation and cleans up waiters", async () => {
	const { engine, rtc } = setup();
	const session = await engine.invite(uri);
	const sending = session.dtmf("9");
	assert.equal(rtc.sent.length, 0);
	rtc.emit("confirmed");
	await sending;
	assert.equal(rtc.sent[0].tones, "9");
	assert.deepEqual(listenerCounts(rtc), [1, 1, 1]);
});

test("accepted rejects when call fails and removes all waiters", async () => {
	const { engine, rtc } = setup();
	const session = await engine.invite(uri);
	const accepted = session.accepted();
	const rejected = assert.rejects(accepted, /Call failed.*Rejected/);
	rtc.finish("failed");
	await rejected;
	assert.deepEqual(listenerCounts(rtc), [1, 1, 1]);
});

test("dtmf rejects on ended calls and if call ends just after confirmation", async () => {
	const { engine, rtc } = setup();
	const session = await engine.invite(uri);
	const sending = session.dtmf("1");
	const rejected = assert.rejects(sending, /ended call/);
	rtc.emit("confirmed");
	rtc.finish("ended");
	await rejected;
	await assert.rejects(session.dtmf("2"), /Call ended/);
	await assert.rejects(session.accepted(), /Call ended/);
	assert.equal(rtc.sent.length, 0);
});

test("system keypad uses the same validation and waits for confirmation", async () => {
	const { engine, rtc, native, errors } = setup();
	await engine.invite(uri);
	native.addDTMFListener({ id: "native-call", digits: "4" });
	await flush();
	assert.equal(rtc.sent.length, 0);
	rtc.emit("confirmed");
	await flush();
	assert.equal(rtc.sent[0].tones, "4");
	native.addDTMFListener({ id: "native-call", digits: "bad!" });
	await flush();
	assert.ok(errors.some((error) => error.operation === "sendDtmfFromSystem"));
});

test("SIP INFO rejection is surfaced with status code and call context", async () => {
	const { engine, rtc, errors } = setup();
	await engine.invite(uri);
	const dtmf = new EventEmitter();
	rtc.emit("newDTMF", { originator: "local", dtmf });
	dtmf.emit("failed", { originator: "remote", response: { status_code: 415, reason_phrase: "Unsupported Media Type" } });
	assert.equal(errors.length, 1);
	assert.equal(errors[0].operation, "sendDtmf");
	assert.equal(errors[0].nativeCode, "SIP_415");
	assert.equal(errors[0].nativeCallId, "native-call");
	assert.equal(errors[0].sipCallId, "sip-call");
	assert.match(errors[0].message, /Unsupported Media Type/);
});

for (const event of ["failed", "ended"]) {
	test(`automatic DTMF timer is cancelled when call ${event} during delay`, async () => {
		const { engine, rtc, timers, advanceTime, logs } = setup();
		await engine.invite(uri, "123#");
		rtc.emit("confirmed");
		assert.equal(timers.size, 1);
		advanceTime(2000);
		rtc.finish(event);
		assert.equal(timers.size, 0);
		advanceTime(5000);
		await flush();
		assert.equal(rtc.sent.length, 0);
		assert.ok(logs.some(({ args }) => args[0].includes("Cancelled automatic tones")));
	});
}

test("automatic send failures are logged even without an error subscriber", async () => {
	const { engine, rtc, logs, advanceTime } = setup();
	engine.errorListeners.clear();
	rtc.sendDTMF = () => {
		throw new Error("SIP transport unavailable");
	};
	await engine.invite(uri, "123#");
	rtc.emit("confirmed");
	advanceTime(5000);
	await flush();
	assert.ok(logs.some(({ level, args }) => level === "error" && args[1].message.includes("SIP transport unavailable")));
});

test("diagnostics log submission and per-tone SIP acknowledgement without logging digits", async () => {
	const { engine, rtc, logs, advanceTime } = setup();
	await engine.invite(uri, "739821#");
	rtc.emit("confirmed");
	advanceTime(5000);
	await flush();
	const dtmf = new EventEmitter();
	dtmf.duration = 100;
	rtc.emit("newDTMF", { originator: "local", dtmf });
	dtmf.emit("succeeded", { response: { status_code: 200, reason_phrase: "OK" } });
	for (const message of ["Waiting for call confirmation", "Scheduled automatic tones", "Automatic tone delay elapsed", "Submitting tone sequence", "Sending individual SIP INFO tone", "SIP INFO tone acknowledged"]) {
		assert.ok(logs.some(({ args }) => args[0].includes(message)), message);
	}
	assert.equal(logs.at(-1).args[1].statusCode, 200);
	assert.equal(logs.at(-1).args[1].sipCallId, "sip-call");
	assert.ok(!JSON.stringify(logs).includes("739821"));
});

test("Android uses native RTP DTMF after the confirmation delay", async () => {
	const { engine, rtc, rtpSent, advanceTime, logs } = setup("android");
	await engine.invite(uri, "12,a#");
	rtc.emit("confirmed");
	await flush();
	assert.equal(rtpSent.length, 0);
	advanceTime(5000);
	await flush();
	assert.deepEqual(rtpSent, [[7, "audio-sender", "12,A#"]]);
	assert.equal(rtc.sent.length, 0);
	assert.ok(logs.some(({ args }) => args[0].includes("Native WebRTC accepted RTP")));
});

test("Android system keypad uses the same RTP bridge", async () => {
	const { engine, rtc, native, rtpSent } = setup("android");
	await engine.invite(uri);
	rtc.emit("confirmed");
	native.addDTMFListener({ id: "native-call", digits: "8" });
	await flush();
	assert.deepEqual(rtpSent, [[7, "audio-sender", "8"]]);
	assert.equal(rtc.sent.length, 0);
});

test("SIP INFO remains an explicit option on Android", async () => {
	const { engine, rtc, rtpSent } = setup("android");
	engine.configuration = { account: { id: "test-account" }, dtmfTransport: "INFO" };
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await session.dtmf("2");
	assert.equal(rtc.sent[0].transport, "INFO");
	assert.equal(rtpSent.length, 0);
});

test("native RTP rejection is reported and never silently falls back to INFO", async () => {
	const { engine, rtc, nativeModule, errors, advanceTime } = setup("android");
	nativeModule.sendRtpDtmf = async () => {
		throw new Error("telephone-event was not negotiated");
	};
	nativeModule.scheduleRtpDtmf = nativeModule.sendRtpDtmf;
	await engine.invite(uri, "2");
	rtc.emit("confirmed");
	advanceTime(5000);
	await flush();
	assert.ok(errors.some((error) => error.operation === "sendDtmf" && error.message.includes("telephone-event")));
	assert.equal(rtc.sent.length, 0);
});

test("missing Android native bridge reports the required rebuild", async () => {
	const { engine, rtc, nativeModule } = setup("android");
	delete nativeModule.sendRtpDtmf;
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await assert.rejects(session.dtmf("2"), /rebuilding the Android app/);
});

function queueState(remainingSymbols, canInsert = true) {
	return { remainingSymbols, canInsert, audioTrackEnabled: true, durationMs: 100, interToneGapMs: 500 };
}

test("RTP diagnostics follow the native queue through all eight digits", async () => {
	const { engine, rtc, nativeModule, logs, advanceTime } = setup("android");
	let remaining = 8;
	nativeModule.getRtpDtmfState = async () => queueState(remaining);
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await session.dtmf("44404041");
	await flush();
	for (remaining = 7; remaining >= 0; remaining--) {
		advanceTime(600);
		await flush();
	}
	const progress = logs.filter(({ args }) => args[0].includes("Native RTP queue progress"));
	assert.deepEqual(progress.map(({ args }) => args[1].remainingSymbols), [8, 7, 6, 5, 4, 3, 2, 1, 0]);
	assert.ok(logs.some(({ args }) => args[0].includes("Native RTP queue drained")));
	assert.ok(!JSON.stringify(logs).includes("44404041"));
});

test("RTP queue stopping after the first tone surfaces an error", async () => {
	const { engine, rtc, nativeModule, errors, advanceTime } = setup("android");
	nativeModule.getRtpDtmfState = async () => queueState(7);
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await session.dtmf("44404041");
	await flush();
	advanceTime(10000);
	await flush();
	assert.ok(errors.some((error) => error.operation === "sendDtmf" && error.message.includes("stalled") && error.message.includes("7 symbols")));
});

test("RTP sender losing capability with queued digits surfaces an error", async () => {
	const { engine, rtc, nativeModule, errors } = setup("android");
	nativeModule.getRtpDtmfState = async () => queueState(7, false);
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await session.dtmf("44404041");
	await flush();
	assert.ok(errors.some((error) => error.message.includes("became unavailable")));
});

test("RTP monitoring stops cleanly when the call ends", async () => {
	const { engine, rtc, nativeModule, errors, timers, advanceTime } = setup("android");
	nativeModule.getRtpDtmfState = async () => queueState(7);
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await session.dtmf("44404041");
	await flush();
	rtc.finish("ended");
	advanceTime(250);
	await flush();
	assert.equal(timers.size, 0);
	assert.equal(errors.length, 0);
});


test("iOS gates both audio directions until CallKit activation and disables on deactivation", async () => {
	const state = setup();
	await state.engine.invite(uri);
	assert.ok(state.audioTransitions.every((item) => !item.isInputAvailable && !item.isOutputAvailable));
	state.setAudioActive(true);
	state.native.addAudioSessionActivatedListener({ calls: [] });
	await flush();
	assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: true, isOutputAvailable: true });
	state.setAudioActive(false);
	state.native.addAudioSessionDeactivatedListener({ calls: [] });
	await flush();
	assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: false, isOutputAvailable: false });
});

test("iOS recovers CallKit activation that happened before JS subscribed", async () => {
	const state = setup("ios", true);
	await flush();
	assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: true, isOutputAvailable: true });
});

test("queued activation cannot enable audio after native deactivation", async () => {
	const state = setup();
	await flush();
	state.setAudioActive(true);
	state.native.addAudioSessionActivatedListener({ calls: [] });
	state.setAudioActive(false);
	state.native.addAudioSessionDeactivatedListener({ calls: [] });
	await flush();
	assert.ok(state.audioTransitions.every((item) => !item.isInputAvailable && !item.isOutputAvailable));
});

test("audio transition failures are reported, block media creation, and allow recovery", async () => {
	const state = setup();
	await flush();
	state.failAudioTransition(new Error("Audio engine failed"));
	state.setAudioActive(true);
	state.native.addAudioSessionActivatedListener({ calls: [] });
	await flush();
	assert.ok(state.errors.some((error) => error.operation === "audioSession"));
	await assert.rejects(state.engine.invite(uri), /Audio engine failed/);
	assert.equal(state.starts(), 0);
	state.failAudioTransition(undefined);
	await state.engine.invite(uri);
	assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: true, isOutputAvailable: true });
});

test("Android never touches the Apple audio device module", async () => {
	const state = setup("android");
	await state.engine.invite(uri);
	assert.equal(state.audioTransitions.length, 0);
	assert.equal(state.native.addAudioSessionActivatedListener, undefined);
});


test("media creation waits for the initial audio gate to finish", async () => {
	const state = setup();
	let releaseGate;
	const gate = new Promise((resolve) => {
		releaseGate = resolve;
	});
	const originalTransition = state.audioDeviceModule.setEngineAvailability;
	state.audioDeviceModule.setEngineAvailability = async (availability) => {
		await gate;
		await originalTransition(availability);
	};
	const invite = state.engine.invite(uri);
	await flush();
	assert.equal(state.starts(), 0);
	releaseGate();
	await invite;
	assert.equal(state.starts(), 1);
});

test("native incoming answer prepares the engine gate without requesting CallKit again", async () => {
	const state = setup();
	await flush();
	state.rtc.isEstablished = () => false;
	let answered = false;
	state.rtc.answer = () => {
		answered = true;
		assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: false, isOutputAvailable: false });
	};
	state.engine.attachSession(state.rtc, "native-call", state.rtc.id, "incoming");
	state.native.addCallAnsweredListener({ id: "native-call", requestId: "answer-request" });
	await flush();
	assert.equal(answered, true);
	assert.deepEqual(state.answerRequests, []);
	state.setAudioActive(true);
	state.native.addAudioSessionActivatedListener({ calls: [] });
	await flush();
	assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: true, isOutputAvailable: true });
});

test("iOS in-app accept uses CallKit and fulfills its answer before audio activation", async () => {
	const state = setup();
	await flush();
	let answers = 0;
	state.rtc.isEstablished = () => false;
	state.rtc.answer = () => {
		answers++;
	};
	const session = state.engine.attachSession(state.rtc, "native-call", state.rtc.id, "incoming");

	await session.accept();
	assert.deepEqual(state.answerRequests, ["native-call"]);
	assert.equal(answers, 0, "SIP must wait for the native answer action");

	state.native.addCallAnsweredListener({ id: "native-call", requestId: "answer-request" });
	await flush();
	assert.equal(answers, 1);
	assert.deepEqual(state.answerRequests, ["native-call"], "Native callback must not request another transaction");

	state.rtc.emit("confirmed");
	await flush();
	assert.deepEqual(state.fulfilledAnswers, ["answer-request"]);
	assert.deepEqual(state.reportedConnections, [], "Incoming confirmation must fulfill its answer request");
	assert.ok(state.audioTransitions.every((item) => !item.isInputAvailable && !item.isOutputAvailable));

	state.setAudioActive(true);
	state.native.addAudioSessionActivatedListener({ calls: [] });
	await flush();
	assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: true, isOutputAvailable: true });
	state.rtc.isEstablished = () => true;
	await session.accept();
	assert.deepEqual(state.answerRequests, ["native-call"], "Accepting an established call must be a no-op");
});

test("CallKit answer received before SIP session attachment answers media without another transaction", async () => {
	const state = setup();
	await flush();
	let answers = 0;
	state.rtc.isEstablished = () => false;
	state.rtc.answer = () => {
		answers++;
	};
	state.native.addCallAnsweredListener({ id: "native-call", requestId: "answer-request" });
	await flush();
	assert.equal(answers, 0);

	state.engine.attachSession(state.rtc, "native-call", state.rtc.id, "incoming");
	await flush();
	assert.equal(answers, 1);
	assert.deepEqual(state.answerRequests, []);
	state.rtc.emit("confirmed");
	await flush();
	assert.deepEqual(state.fulfilledAnswers, ["answer-request"]);
});

test("rejected iOS in-app answer does not start SIP media and can be retried", async () => {
	const state = setup();
	await flush();
	let answers = 0;
	state.rtc.isEstablished = () => false;
	state.rtc.answer = () => {
		answers++;
	};
	const session = state.engine.attachSession(state.rtc, "native-call", state.rtc.id, "incoming");
	const originalAnswerCall = state.calls.answerCall;
	state.calls.answerCall = async () => {
		throw new Error("CallKit rejected the answer");
	};
	await assert.rejects(session.accept(), /CallKit rejected/);
	assert.equal(answers, 0);

	state.calls.answerCall = originalAnswerCall;
	await session.accept();
	assert.deepEqual(state.answerRequests, ["native-call"]);
});

for (const platform of ["ios", "android"]) {
	for (const engineFile of ["../JsSipTelephonyEngine.ts", "../../../build/telephony/JsSipTelephonyEngine.js"]) {
		test(`${platform} in-app accept waits for native readiness and fulfills the incoming answer (${engineFile})`, async () => {
			const state = setup(platform, false, engineFile);
			await flush();
			let answers = 0;
			state.rtc.isEstablished = () => false;
			state.rtc.answer = () => {
				answers++;
			};
			const session = state.engine.attachSession(state.rtc, "native-call", state.rtc.id, "incoming");

			await session.accept();
			assert.deepEqual(state.answerRequests, ["native-call"]);
			assert.equal(answers, 0, "SIP must wait for the native answer callback");

			state.native.addCallAnsweredListener({ id: "native-call", requestId: "answer-request" });
			await flush();
			assert.equal(answers, 1);
			assert.deepEqual(state.answerRequests, ["native-call"], "Native callback must not request another answer");

			state.rtc.emit("confirmed");
			await flush();
			assert.deepEqual(state.fulfilledAnswers, ["answer-request"]);
			assert.deepEqual(state.reportedConnections, []);
			if (platform === "android") assert.deepEqual(state.audioTransitions, []);

			state.rtc.isEstablished = () => true;
			await session.accept();
			assert.equal(answers, 1);
			assert.deepEqual(state.answerRequests, ["native-call"]);
		});
	}
}

test("closing the engine disables audio even while the native session still appears active", async () => {
	const state = setup("ios", true);
	await flush();
	state.engine.ua = undefined;
	await state.engine.close();
	assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: false, isOutputAvailable: false });
	state.native.addAudioSessionActivatedListener({ calls: [] });
	await flush();
	assert.deepEqual(state.audioTransitions.at(-1), { isInputAvailable: false, isOutputAvailable: false });
});

test("iOS hands its post-confirmation delay to native without JS timers", async () => {
	const { engine, rtc, rtpSent, nativeScheduled, timers } = setup("ios");
	engine.configuration.dtmfTransport = undefined;
	await engine.invite(uri, "12,a#");
	rtc.emit("confirmed");
	await flush();
	assert.equal(rtpSent.length, 0);
	assert.deepEqual(nativeScheduled, [[7, "audio-sender", "12,A#", 5000, "native-call"]]);
	assert.equal(timers.size, 0);
	assert.equal(rtc.sent.length, 0);
});

test("iOS keypad tones use native RTP immediately on a confirmed call", async () => {
	const { engine, rtc, native, rtpSent } = setup("ios");
	engine.configuration.dtmfTransport = undefined;
	await engine.invite(uri);
	rtc.emit("confirmed");
	native.addDTMFListener({ id: "native-call", digits: "5" });
	await flush();
	assert.deepEqual(rtpSent, [[7, "audio-sender", "5"]]);
	assert.equal(rtc.sent.length, 0);
});

test("iOS native RTP rejection is reported without falling back to SIP INFO", async () => {
	const { engine, rtc, nativeModule, errors, advanceTime } = setup("ios");
	engine.configuration.dtmfTransport = undefined;
	nativeModule.sendRtpDtmf = async () => {
		throw new Error("telephone-event was not negotiated");
	};
	nativeModule.scheduleRtpDtmf = nativeModule.sendRtpDtmf;
	await engine.invite(uri, "2");
	rtc.emit("confirmed");
	advanceTime(5000);
	await flush();
	assert.ok(errors.some((error) => error.operation === "sendDtmf"));
	assert.equal(rtc.sent.length, 0);
});

test("iOS monitors its native RTP queue", async () => {
	const { engine, rtc, nativeModule, logs, advanceTime } = setup("ios");
	engine.configuration.dtmfTransport = undefined;
	let remaining = 2;
	nativeModule.getRtpDtmfState = async () => queueState(remaining);
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await session.dtmf("12");
	await flush();
	remaining = 0;
	advanceTime(600);
	await flush();
	assert.ok(logs.some(({ args }) => args[0].includes("Native RTP queue drained")));
});

test("missing iOS native DTMF bridge requests a rebuild", async () => {
	const { engine, rtc, nativeModule } = setup("ios");
	engine.configuration.dtmfTransport = undefined;
	delete nativeModule.sendRtpDtmf;
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await assert.rejects(session.dtmf("2"), /rebuilding the iOS app/);
});

test("iOS pending native schedule is cancelled when the SIP call ends", async () => {
	const { engine, rtc, nativeModule, nativeCancelled, timers } = setup("ios");
	engine.configuration.dtmfTransport = undefined;
	let resolveNative;
	nativeModule.scheduleRtpDtmf = () => new Promise((resolve) => {
		resolveNative = resolve;
	});
	await engine.invite(uri, "123");
	rtc.emit("confirmed");
	await flush();
	rtc.finish("ended");
	await flush();
	assert.deepEqual(nativeCancelled, [[7, "audio-sender"]]);
	resolveNative({ cancelled: true });
	await flush();
	assert.equal(timers.size, 0);
});

test("iOS native queue completion avoids JS progress polling", async () => {
	const { engine, rtc, nativeModule, timers, logs } = setup("ios");
	engine.configuration.dtmfTransport = undefined;
	nativeModule.sendRtpDtmf = async () => ({ nativeQueueDrained: true });
	nativeModule.getRtpDtmfState = () => {
		throw new Error("JS polling should not be used");
	};
	const session = await engine.invite(uri);
	rtc.emit("confirmed");
	await session.dtmf("123");
	assert.equal(timers.size, 0);
	assert.ok(logs.some(({ args }) => args[0].includes("Native RTP queue drained")));
});

test("generated package entry schedules iOS tones natively before any JS delay", async () => {
	const { engine, rtc, nativeScheduled, timers, logs } = setup(
		"ios", false, "../../../build/telephony/JsSipTelephonyEngine.js"
	);
	engine.configuration.dtmfTransport = undefined;
	await engine.invite(uri, ",1234");
	rtc.emit("confirmed");
	await flush();
	assert.deepEqual(nativeScheduled, [[7, "audio-sender", ",1234", 5000, "native-call"]]);
	assert.equal(timers.size, 0);
	assert.ok(logs.some(({ args }) => args[0].includes("iOS DTMF runtime") && args[1].nativeSchedulerVersion === 2));
	assert.ok(!logs.some(({ args }) => args[0].includes("Scheduled automatic tones after confirmation")));
});

for (const platform of ["ios", "android"]) {
	test(`${platform} user hang-up before answer cancels invite tones without an error`, async () => {
		const { engine, rtc, errors, logs, timers, nativeScheduled, rtpSent, reportedEnds } = setup(platform);
		rtc.terminate = () => {
			rtc.ended = true;
			rtc.emit("failed", { originator: "local", cause: "Canceled" });
		};
		const session = await engine.invite(uri, ",44404041");
		await session.terminate();
		await flush();
		assert.equal(errors.length, 0);
		assert.ok(logs.every(({ level }) => level !== "error"));
		assert.equal(timers.size, 0);
		assert.equal(nativeScheduled.length, 0);
		assert.equal(rtpSent.length, 0);
		assert.equal(engine.getSessions().length, 0);
		assert.equal(session.snapshot.status, "terminated");
		assert.deepEqual(reportedEnds, [["native-call", "unanswered"]]);
	});
}

for (const event of [
	{ originator: "remote", cause: "Canceled" },
	{ originator: "local", cause: "Connection Error" },
]) {
	test(`genuine SIP failure remains visible: ${event.originator} ${event.cause}`, async () => {
		const { engine, rtc, errors, logs, reportedEnds } = setup();
		await engine.invite(uri, "123");
		rtc.ended = true;
		rtc.emit("failed", event);
		await flush();
		assert.equal(errors[0].operation, "sessionFailed");
		assert.ok(errors[0].message.includes(event.cause));
		assert.deepEqual(reportedEnds, [["native-call", "failed"]]);
	});
}

const audioDeviceTestCases = ["ios", "android"].flatMap((platform) =>
	["../JsSipTelephonyEngine.ts", "../../../build/telephony/JsSipTelephonyEngine.js"]
	.map((engineFile) => ({ platform, engineFile }))
);

for (const { platform, engineFile } of audioDeviceTestCases) {
	test(`${platform} audio activity follows native observations without optimistic selection (${engineFile})`, async () => {
		const { engine, nativeModule, native } = setup(platform, false, engineFile);
		const speaker = { id: "output:speaker", direction: "output", isActive: true };
		const headset = { id: "output:paired:input-uid", direction: "output", isActive: false };
		const microphone = { id: "input:mic", direction: "input", isActive: null };
		let outputs = [speaker, headset];
		nativeModule.getAudioDevices = (direction) => direction === "input" ? [microphone] : outputs;
		nativeModule.setAudioDevice = async () => {
		};
		const session = await engine.invite(uri);
		const before = engine.getAudioDevices("output");
		assert.equal(before.find((device) => device.isActive === true).id, speaker.id);
		assert.equal(engine.getAudioDevices("input")[0].isActive, null);
		await session.setOutput(headset);
		assert.equal(engine.getAudioDevices("output")[1].isActive, false);
		const observed = [];
		const unsubscribe = engine.subscribeToAudioDevices(() => {
			observed.push(engine.getAudioDevices("output").find((device) => device.isActive === true)?.id);
		});
		// This could equally be a change made through the native call screen.
		outputs = [{ ...speaker, isActive: false }, { ...headset, isActive: true }];
		native.addAudioRouteChangedListener({ currentRoute: {} });
		assert.deepEqual(observed, [headset.id]);
		assert.equal(before[0].isActive, true, "Previously returned snapshots must remain unchanged");
		outputs = [{ ...speaker, isActive: null }, { ...headset, isActive: null }];
		native.addAudioRouteChangedListener({ currentRoute: {} });
		assert.deepEqual(observed, [headset.id, undefined]);
		unsubscribe();
	});

	test(`${platform} audio device selection validates direction, availability and call lifetime (${engineFile})`, async () => {
		const { engine, rtc, nativeModule } = setup(platform, false, engineFile);
		const input = { id: "input:mic", direction: "input", type: "builtin_mic", friendlyName: "Microphone", nativeType: "test", routing: "paired", isActive: null };
		const output = { ...input, id: "output:speaker", direction: "output", type: "builtin_speaker", isActive: false };
		let devices = [input, output];
		const requests = [];
		nativeModule.getAudioDevices = (direction) => devices.filter((device) => device.direction === direction);
		nativeModule.setAudioDevice = async (...args) => {
			requests.push(args);
		};
		const session = await engine.invite(uri);
		assert.equal(engine.getAudioDevices("input")[0], input);
		await session.setInput(input);
		await session.setOutput(output);
		assert.deepEqual(requests, [["native-call", "input", input.id], ["native-call", "output", output.id]]);
		await assert.rejects(session.setInput(output), /Expected an input/);
		await assert.rejects(session.setOutput(input), /Expected an output/);
		devices = [];
		await assert.rejects(session.setInput(input), /no longer available/);
		devices = [input, output];
		rtc.ended = true;
		await assert.rejects(session.setOutput(output), /ended call/);
		assert.equal(requests.length, 2);
	});

	test(`${platform} audio routing propagates native rejection to the caller (${engineFile})`, async () => {
		const { engine, nativeModule } = setup(platform, false, engineFile);
		const device = { id: "output:usb", direction: "output", type: "usb" };
		nativeModule.getAudioDevices = () => [device];
		const failure = new Error("System denied audio routing");
		nativeModule.setAudioDevice = async () => {
			throw failure;
		};
		const session = await engine.invite(uri);
		await assert.rejects(session.setOutput(device), (error) => error === failure);
	});
}

test("audio device subscriptions refresh after native changes and clean up exactly once", async () => {
	const { engine, calls } = setup();
	let callback;
	let removed = 0;
	calls.addAudioRouteChangedListener = (listener) => {
		callback = listener;
		return { remove: () => removed++ };
	};
	let notified = 0;
	const unsubscribe = engine.subscribeToAudioDevices(() => notified++);
	callback({ currentRoute: { inputs: [], outputs: [] } });
	assert.equal(notified, 1);
	unsubscribe();
	unsubscribe();
	assert.equal(removed, 1);
	const unsubscribeOnClose = engine.subscribeToAudioDevices(() => notified++);
	engine.ua = undefined;
	await engine.close();
	unsubscribeOnClose();
	assert.equal(removed, 2);
	assert.throws(() => engine.getAudioDevices("input"), /closed/);
	assert.throws(() => engine.subscribeToAudioDevices(() => {
	}), /closed/);
});


for (const platform of ["ios", "android"]) {
	test(`${platform} overlapping outgoing calls keep independent native IDs and lifecycles`, async () => {
		const state = setup(platform, true);
		const secondRtc = new MockSession();
		secondRtc.id = "sip-second";
		let nextCall = 0;
		state.calls.startOutgoingCall = async () => `native-${++nextCall}`;
		state.engine.ua.call = () => nextCall === 1 ? state.rtc : secondRtc;
		const first = await state.engine.invite("sip:123@example.com");
		state.rtc.emit("confirmed");
		await flush();
		let firstHeld = false;
		state.rtc.hold = () => {
			firstHeld = true;
			state.rtc.emit("hold");
			return true;
		};
		state.rtc.unhold = () => {
			firstHeld = false;
			state.rtc.emit("unhold");
			return true;
		};
		const second = await state.engine.invite("sip:456@example.com");
		state.native.addSetHeldActionListener({ id: first.snapshot.nativeCallId, isOnHold: true });
		await flush();
		assert.equal(firstHeld, true);
		assert.equal(first.snapshot.isOnHold, true);
		assert.equal(second.snapshot.isOnHold, false);
		assert.equal(state.engine.getSessions().length, 2);
		secondRtc.emit("confirmed");
		await flush();
		assert.deepEqual(state.reportedConnections, ["native-1", "native-2"]);
		secondRtc.finish("ended");
		await flush();
		assert.deepEqual(Array.from(state.engine.getSessions(), (session) => session.id), [first.id]);
		assert.deepEqual(state.reportedEnds, [["native-2", "remoteEnded"]]);
		state.native.addSetHeldActionListener({ id: "native-1", isOnHold: false });
		await flush();
		assert.equal(firstHeld, false);
		assert.equal(first.snapshot.isOnHold, false);
	});

	test(`${platform} incoming SIP matches the second push call by SIP Call-ID`, async () => {
		const state = setup(platform);
		state.rtc.direction = "incoming";
		const sessions = [
			{ id: "native-unrelated", origin: "incoming", incomingCallEvent: { serverCallId: "other-sip" } },
			{ id: "native-matched", origin: "incoming", incomingCallEvent: { serverCallId: "incoming-sip" } },
		];
		state.calls.getCallSessions = async () => sessions;
		state.calls.reportIncomingCall = async () => {
			assert.fail("Existing push call must be reused");
		};
		await state.engine.onRtcSession({ session: state.rtc, request: { call_id: "incoming-sip" } });
		assert.equal(state.engine.getSessions().length, 1);
		assert.equal(state.engine.getSession("incoming-sip").snapshot.nativeCallId, "native-matched");
	});

	test(`${platform} new incoming call uses its returned native ID with an outgoing call present`, async () => {
		const state = setup(platform);
		const first = await state.engine.invite("sip:123@example.com");
		const incoming = new MockSession();
		incoming.id = "incoming-second";
		incoming.direction = "incoming";
		state.calls.getCallSessions = async () => [{ id: first.snapshot.nativeCallId, origin: "outgoingApp" }];
		state.calls.reportIncomingCall = async (event) => {
			assert.equal(event.serverCallId, "incoming-second");
			return "new-native-incoming";
		};
		await state.engine.onRtcSession({ session: incoming, request: { call_id: incoming.id } });
		assert.equal(state.engine.getSessions().length, 2);
		assert.equal(state.engine.getSession(incoming.id).snapshot.nativeCallId, "new-native-incoming");
		assert.equal(first.snapshot.nativeCallId, "native-call");
		incoming.finish("ended");
		await flush();
		assert.equal(state.engine.getSessions().length, 1);
		assert.deepEqual(state.reportedEnds, [["new-native-incoming", "remoteEnded"]]);
	});

	test(`${platform} unrelated unclaimed incoming calls are never attached by store order`, async () => {
		const state = setup(platform);
		state.rtc.direction = "incoming";
		state.calls.getCallSessions = async () => [
			{ id: "unclaimed", origin: "incoming", incomingCallEvent: { serverCallId: "different-sip" } },
		];
		state.calls.reportIncomingCall = async () => "correct-native";
		await state.engine.onRtcSession({ session: state.rtc, request: { call_id: "correct-sip" } });
		assert.equal(state.engine.getSession("correct-sip").snapshot.nativeCallId, "correct-native");
	});

	test(`${platform} failing to start a consultation call preserves the original session`, async () => {
		const state = setup(platform, true);
		const first = await state.engine.invite("sip:123@example.com");
		state.calls.startOutgoingCall = async () => {
			throw new Error("OS capacity reached");
		};
		await assert.rejects(state.engine.invite("sip:456@example.com"), /OS capacity reached/);
		assert.deepEqual(Array.from(state.engine.getSessions(), (session) => session.id), [first.id]);
		assert.deepEqual(state.reportedEnds, []);
	});
}


const setupTransfer = (platform, engineFile) => {
	const state = setup(platform, true, engineFile);
	const refers = [];
	let terminations = 0;
	state.rtc.isEstablished = () => true;
	state.rtc.terminate = () => {
		terminations++;
		state.rtc.finish("ended");
	};
	state.rtc.refer = (target, options) => {
		const subscriber = new EventEmitter();
		for (const [name, handler] of Object.entries(options.eventHandlers)) subscriber.on(name, handler);
		refers.push({ target, options, subscriber });
		return subscriber;
	};
	const source = state.engine.attachSession(state.rtc, "native-source", "sip-source", "outgoing");
	const targetRtc = new MockSession();
	targetRtc.id = "sip-target";
	targetRtc.isEstablished = () => true;
	targetRtc.remote_identity = { uri: require("jssip").URI.parse("sip:consultation@example.com") };
	const target = state.engine.attachSession(targetRtc, "native-target", "sip-target", "outgoing");
	return { ...state, source, target, targetRtc, refers, terminations: () => terminations };
};

for (const platform of ["ios", "android"]) {
	for (const engineFile of ["../JsSipTelephonyEngine.ts", "../../../build/telephony/JsSipTelephonyEngine.js"]) {
		const label = `${platform} transfer (${engineFile})`;

		test(`${label} blind transfer ends only the source after REFER acceptance`, async () => {
			const state = setupTransfer(platform, engineFile);
			const before = listenerCounts(state.rtc);
			const transferred = state.source.blindTransfer("sip:456@example.com");
			assert.equal(state.terminations(), 0);
			assert.equal(state.refers[0].target, "sip:456@example.com");
			assert.equal(state.refers[0].options.replaces, undefined);
			state.refers[0].subscriber.emit("requestSucceeded", { response: { status_code: 202 } });
			assert.equal(await transferred, true);
			await flush();
			assert.equal(state.terminations(), 1);
			assert.equal(state.engine.getSession(state.source.id), undefined);
			assert.equal(state.engine.getSession(state.target.id), state.target);
			assert.deepEqual(state.reportedEnds, [["native-source", "remoteEnded"]]);
			assert.deepEqual(listenerCounts(state.rtc), before);
			assert.equal(state.refers[0].subscriber.listenerCount("requestFailed"), 0);
			assert.equal(state.timers.size, 0);
		});

		for (const entryPoint of ["client", "session"]) {
			test(`${label} attended transfer through ${entryPoint} passes the consultation dialog as Replaces`, async () => {
				const state = setupTransfer(platform, engineFile);
				const transferred = entryPoint === "client"
					? state.engine.attendedTransfer({ id: state.source.id }, { id: state.target.id })
					: state.source.attendedTransfer(state.target);
				assert.equal(state.refers[0].target, "sip:consultation@example.com");
				assert.equal(state.refers[0].options.replaces, state.targetRtc);
				state.refers[0].subscriber.emit("requestSucceeded");
				assert.equal(await transferred, true);
				await flush();
				assert.equal(state.targetRtc.ended, false);
				assert.equal(state.engine.getSessions().length, 1);
			});
		}

		test(`${label} rejection preserves both calls and permits retry`, async () => {
			const state = setupTransfer(platform, engineFile);
			const first = state.source.blindTransfer("sip:456@example.com");
			state.refers[0].subscriber.emit("requestFailed", { response: { status_code: 603 } });
			assert.equal(await first, false);
			assert.equal(state.terminations(), 0);
			assert.equal(state.engine.getSessions().length, 2);
			const retry = state.source.blindTransfer("sip:789@example.com");
			state.refers[1].subscriber.emit("requestSucceeded");
			assert.equal(await retry, true);
		});

		test(`${label} times out after 20 seconds and ignores late REFER acceptance`, async () => {
			const state = setupTransfer(platform, engineFile);
			const before = listenerCounts(state.rtc);
			let resolved = false;
			const transferred = state.source.blindTransfer("sip:456@example.com").then((success) => {
				resolved = true;
				return success;
			});
			state.advanceTime(19_999);
			await flush();
			assert.equal(resolved, false);
			state.advanceTime(1);
			assert.equal(await transferred, false);
			// Exercise the saved callback as well as the now-detached emitter.
			state.refers[0].options.eventHandlers.requestSucceeded();
			state.refers[0].subscriber.emit("requestSucceeded");
			await flush();
			assert.equal(state.terminations(), 0);
			assert.equal(state.engine.getSessions().length, 2);
			assert.deepEqual(listenerCounts(state.rtc), before);
			assert.equal(state.timers.size, 0);
		});

		test(`${label} source or consultation hangup settles pending transfers and cleans listeners`, async () => {
			for (const leg of ["rtc", "targetRtc"]) {
				const state = setupTransfer(platform, engineFile);
				const before = listenerCounts(state.targetRtc);
				const transferred = state.engine.attendedTransfer(state.source, state.target);
				state[leg].finish("ended");
				assert.equal(await transferred, false);
				state.refers[0].options.eventHandlers.requestSucceeded();
				await flush();
				assert.equal(state.terminations(), 0);
				assert.equal(state.timers.size, 0);
				assert.deepEqual(listenerCounts(state.targetRtc), before);
				assert.equal(state.refers[0].subscriber.listenerCount("requestSucceeded"), 0);
			}
		});

		test(`${label} invalid targets and session references reject before sending REFER`, async () => {
			const state = setupTransfer(platform, engineFile);
			for (const invalid of ["", "123", "sip:", "not a SIP URI", "sip:123@example.com\r\nX-Header: injected"]) {
				await assert.rejects(state.source.blindTransfer(invalid), /valid SIP URI/);
			}
			await assert.rejects(state.engine.attendedTransfer({ id: "missing" }, state.target), /Session A not found/);
			await assert.rejects(state.engine.attendedTransfer(state.source, { id: "missing" }), /Session B not found/);
			await assert.rejects(state.source.attendedTransfer(state.source), /itself/);
			state.targetRtc.isEstablished = () => false;
			await assert.rejects(state.source.attendedTransfer(state.target), /target session must be established/);
			state.rtc.isEstablished = () => false;
			await assert.rejects(state.source.blindTransfer("sip:456@example.com"), /source session must be established/);
			state.rtc.ended = true;
			await assert.rejects(state.source.blindTransfer("sip:456@example.com"), /ended or removed/);
			assert.equal(state.refers.length, 0);
			assert.equal(state.timers.size, 0);
		});

		test(`${label} concurrent transfers reject and synchronous send errors clean up`, async () => {
			const state = setupTransfer(platform, engineFile);
			const before = listenerCounts(state.rtc);
			const transferred = state.source.blindTransfer("sip:456@example.com");
			await assert.rejects(state.source.blindTransfer("sip:789@example.com"), /already in progress/);
			state.refers[0].subscriber.emit("requestFailed");
			assert.equal(await transferred, false);
			state.rtc.refer = () => {
				throw new Error("Transport unavailable");
			};
			await assert.rejects(state.source.blindTransfer("sip:456@example.com"), /Transport unavailable/);
			assert.deepEqual(listenerCounts(state.rtc), before);
			assert.equal(state.timers.size, 0);
			state.rtc.refer = () => false;
			assert.equal(await state.source.blindTransfer("sip:456@example.com"), false);
			assert.equal(state.timers.size, 0);
		});
	}
}

test("attended transfer generates a real JsSIP REFER with escaped Replaces dialog identifiers", async () => {
	const state = setupTransfer("ios");
	const ReferSubscriber = require("jssip/lib/RTCSession/ReferSubscriber");
	let request;
	let respond;
	state.rtc._ua = { _configuration: { uri: require("jssip").URI.parse("sip:local@example.com") } };
	state.rtc.contact = "<sip:local@example.com>";
	state.targetRtc._request = { call_id: "consultation-call@server" };
	state.targetRtc._to_tag = "remote-tag";
	state.targetRtc._from_tag = "local-tag";
	state.rtc.sendRequest = (method, options) => {
		request = { method, options };
		respond = options.eventHandlers.onSuccessResponse;
		return { cseq: 23 };
	};
	state.rtc.refer = (target, options) => {
		const subscriber = new ReferSubscriber(state.rtc);
		subscriber.sendRefer(target, options);
		return subscriber;
	};
	const transferred = state.engine.attendedTransfer(state.source, state.target);
	assert.equal(request.method, "REFER");
	assert.ok(request.options.extraHeaders.includes(
		"Refer-To: <sip:consultation@example.com?Replaces=consultation-call%40server%3Bto-tag%3Dremote-tag%3Bfrom-tag%3Dlocal-tag>"
	));
	respond({ status_code: 202 });
	assert.equal(await transferred, true);
	assert.equal(state.terminations(), 1);
});

// Admission behavior is native on iOS; these tests exercise JS's handling of its decisions.
test("iOS attaches an ID-less push match without reporting a second native call", async () => {
	const state = setup();
	state.nativeModule.claimIncomingSipCall = async () => ({ decision: "matched", nativeCallId: "push-native" });
	state.calls.reportIncomingCall = async () => assert.fail("Must reuse the push call");
	await state.engine.onRtcSession({ session: state.rtc, request: { call_id: "asterisk-id" } });
	assert.equal(state.engine.getSession("asterisk-id").snapshot.nativeCallId, "push-native");
});

test("iOS rejects expired or ambiguous admission without reporting or answering", async () => {
	for (const reason of ["expiredOrClaimed", "ambiguous"]) {
		const state = setup();
		state.nativeModule.claimIncomingSipCall = async () => ({ decision: "reject", reason });
		let status;
		state.rtc.terminate = (options) => { status = options.status_code; };
		state.calls.reportIncomingCall = async () => assert.fail("Rejected INVITE must not ring");
		await state.engine.onRtcSession({ session: state.rtc, request: { call_id: "late" } });
		assert.equal(status, 480);
		assert.equal(state.engine.getSessions().length, 0);
	}
});

test("ending before SIP arrives clears the pending answer", async () => {
	const state = setup();
	await state.engine.answerFromSystem("push-native", "request");
	assert.equal(state.engine.pendingAnswerRequest.size, 1);
	await state.engine.endFromSystem("push-native");
	assert.equal(state.engine.pendingAnswerRequest.size, 0);
	assert.deepEqual(state.failedAnswers, [["push-native", "request"]]);
});

test("a stale queued iOS answer is discarded", async () => {
	const state = setup();
	state.nativeModule.validateIncomingSipCall = async () => false;
	await state.engine.answerFromSystem("push-native", "stale-request");
	assert.equal(state.engine.pendingAnswerRequest.size, 0);
	assert.deepEqual(state.failedAnswers, [["push-native", "stale-request"]]);
});

test("SIP CANCEL during native admission ends the push call without attaching", async () => {
	const state = setup();
	state.nativeModule.claimIncomingSipCall = async () => {
		state.rtc.ended = true;
		return { decision: "matched", nativeCallId: "push-native" };
	};
	await state.engine.onRtcSession({ session: state.rtc, request: { call_id: "cancelled" } });
	assert.equal(state.engine.getSessions().length, 0);
	assert.deepEqual(state.reportedEnds, [["push-native", "remoteEnded"]]);
});

test("ending during audio preparation prevents SIP answer", async () => {
	const state = setup();
	state.rtc.isEstablished = () => false;
	state.rtc.terminate = () => { state.rtc.ended = true; };
	state.rtc.answer = () => assert.fail("Ended call cannot be answered");
	state.engine.attachSession(state.rtc, "native-call", state.rtc.id, "incoming");
	state.engine.synchronizeCallKitAudio = async () => { await state.engine.endFromSystem("native-call"); };
	await state.engine.answerFromSystem("native-call", "request");
	assert.equal(state.engine.pendingAnswerRequest.size, 0);
});

test("failed iOS answer fulfillment terminates SIP media", async () => {
	const state = setup();
	state.rtc.isEstablished = () => false;
	state.rtc.answer = () => {};
	state.rtc.terminate = () => { state.rtc.ended = true; };
	const session = state.engine.attachSession(state.rtc, "native-call", state.rtc.id, "incoming");
	await state.engine.answerFromSystem("native-call", "request");
	state.nativeModule.fulfillIncomingCallAnswered = async () => false;
	await state.engine.confirmSession(session);
	assert.equal(state.rtc.ended, true);
	assert.deepEqual(state.reportedEnds, [["native-call", "failed"]]);
});
