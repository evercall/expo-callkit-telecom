// Run with: node --test src/telephony/__tests__/HeadlessTelephony.test.cjs
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function setup(platform = "android") {
	const tasks = new Map();
	const removedListeners = new Set();
	let activeSessions = [{ id: "call-1" }];
	let readSession = async (id) => activeSessions.find((session) => session.id === id) ?? null;
	const module = { exports: {} };
	const compiled = ts.transpileModule(
		readFileSync(resolve(__dirname, "../HeadlessTelephony.ts"), "utf8"),
		{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
	);
	const imports = {
		"react-native": {
			Platform: { OS: platform },
			AppRegistry: { registerHeadlessTask: (name, provider) => tasks.set(name, provider) },
		},
		"../Calls": {
			addCallSessionRemovedListener: (listener) => {
				removedListeners.add(listener);
				return { remove: () => removedListeners.delete(listener) };
			},
			getCallSession: (id) => readSession(id),
		},
	};
	vm.runInNewContext(compiled.outputText, {
		module, exports: module.exports,
		require(name) {
			assert.ok(name in imports, `Unexpected import: ${name}`);
			return imports[name];
		},
	});
	return {
		tasks, removedListeners, exports: module.exports,
		start: (callId = "call-1") => tasks.get("ExpoCallKitTelecomCallTask")()({ event: "callActive", callId }),
		setActive: (session) => {
			activeSessions = session ? [session] : [];
		},
		setSessions: (sessions) => {
			activeSessions = sessions;
		},
		setReader: (reader) => {
			readSession = reader;
		},
		remove: (id) => {
			for (const listener of removedListeners) listener({ id });
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("call task registers automatically and remains pending until its call is removed", async () => {
	const state = setup();
	let finished = false;
	const task = state.start().then(() => {
		finished = true;
	});
	await flush();
	assert.equal(finished, false);
	state.remove("another-call");
	await flush();
	assert.equal(finished, false);
	state.setActive(null);
	state.remove("call-1");
	await task;
	assert.equal(finished, true);
	assert.equal(state.removedListeners.size, 0);
});

for (const session of [null, { id: "another-call" }]) {
	test(`task exits when its call is no longer active (${session?.id ?? "none"})`, async () => {
		const state = setup();
		state.setActive(session);
		await state.start();
		assert.equal(state.removedListeners.size, 0);
	});
}

test("call removal during the initial native query cannot leave the task hanging", async () => {
	const state = setup();
	let resolveQuery;
	state.setReader(() => new Promise((resolve) => {
		resolveQuery = resolve;
	}));
	const task = state.start();
	state.remove("call-1");
	resolveQuery({ id: "call-1" });
	await task;
	assert.equal(state.removedListeners.size, 0);
});

test("native state query failures clean up the listener", async () => {
	const state = setup();
	state.setReader(async () => {
		throw new Error("Native query failed");
	});
	await assert.rejects(state.start(), /Native query failed/);
	assert.equal(state.removedListeners.size, 0);
});

test("a task without a call identifier exits immediately", async () => {
	const state = setup();
	await state.start(null);
	assert.equal(state.removedListeners.size, 0);
});

test("call-lifetime registration does not invoke or replace the restoration handler", async () => {
	const state = setup();
	let restored = 0;
	state.exports.registerAndroidTelephonyHeadlessTask(async () => {
		restored++;
	});
	const task = state.start();
	await flush();
	assert.equal(restored, 0);
	await state.tasks.get("ExpoCallKitTelecomHeadlessTask")()({ event: "answer" });
	assert.equal(restored, 1);
	state.remove("call-1");
	await task;
});

test("iOS registers neither Android headless task", () => {
	const state = setup("ios");
	state.exports.registerAndroidTelephonyHeadlessTask(async () => {
	});
	assert.equal(state.tasks.size, 0);
});


test("each overlapping call task stays alive until its own call ends", async () => {
	const state = setup();
	state.setSessions([{ id: "call-1" }, { id: "call-2" }]);
	let firstFinished = false;
	let secondFinished = false;
	const first = state.start("call-1").then(() => {
		firstFinished = true;
	});
	const second = state.start("call-2").then(() => {
		secondFinished = true;
	});
	await flush();
	assert.equal(firstFinished, false);
	assert.equal(secondFinished, false, "Second call must not exit because it is not first in the store");
	state.remove("call-1");
	await first;
	assert.equal(secondFinished, false);
	assert.equal(state.removedListeners.size, 1);
	state.remove("call-2");
	await second;
	assert.equal(state.removedListeners.size, 0);
});
