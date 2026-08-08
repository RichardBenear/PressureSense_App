import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// NOTE: on some local setups, any test below that opens a real WebSocket
// against the RELAY Durable Object (device or browser socket) can fail
// isolated-storage teardown with "Failed to pop isolated storage stack
// frame" / EBUSY, even in tests unrelated to this file's changes. That's a
// pre-existing environment issue (workerd/miniflare version mismatch with
// wrangler.jsonc's compatibility_date -- watch for the "Falling back to
// <date>" warning in the test runner's output) and not something these
// tests do wrong; if it happens locally, verify in CI or with an updated
// @cloudflare/vitest-pool-workers / workerd instead of chasing it here.

async function login(password = "test-password") {
	const res = await SELF.fetch("http://example.com/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	const setCookie = res.headers.get("Set-Cookie") || "";
	const cookie = setCookie.split(";")[0]; // "ps_session=<token>"
	return { res, cookie };
}

describe("public pages", () => {
	it("serves / with no session cookie", async () => {
		const res = await SELF.fetch("http://example.com/");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("<title>PressureSense — Remote</title>");
	});

	// /ws's own cookie gate was removed (see src/index.js) -- the
	// "PressureSenseRelay /ws allow-list" tests below connect straight to the
	// Durable Object and prove a browser socket needs no cookie to read, and
	// can't mutate anything regardless.
});

describe("POST /api/command", () => {
	it("rejects with 401 when no session cookie is present", async () => {
		const res = await SELF.fetch("http://example.com/api/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cmd: "manualZone", action: "start" }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects with 401 when the session cookie is invalid", async () => {
		const res = await SELF.fetch("http://example.com/api/command", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: "ps_session=bogus.sig" },
			body: JSON.stringify({ cmd: "manualZone", action: "start" }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects a non-allow-listed cmd even with a valid cookie", async () => {
		const { cookie } = await login();
		const res = await SELF.fetch("http://example.com/api/command", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ cmd: "getHistory" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 503 when the device is offline", async () => {
		const { cookie } = await login();
		const res = await SELF.fetch("http://example.com/api/command", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ cmd: "manualZone", action: "start", controller: "yard", znumber: "1", run: "5" }),
		});
		expect(res.status).toBe(503);
	});

	it("forwards an allow-listed cmd to the device when the cookie is valid", async () => {
		const id = env.RELAY.idFromName("singleton");
		const stub = env.RELAY.get(id);
		const deviceRes = await stub.fetch(new Request("http://x/device", { headers: { Upgrade: "websocket" } }));
		const deviceWs = deviceRes.webSocket;
		deviceWs.accept();

		let received = null;
		deviceWs.addEventListener("message", (evt) => { received = JSON.parse(evt.data); });

		const { cookie } = await login();
		const res = await SELF.fetch("http://example.com/api/command", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ cmd: "manualZone", action: "start", controller: "yard", znumber: "1", run: "5" }),
		});

		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 20));
		expect(received).toMatchObject({ cmd: "manualZone", action: "start" });

		deviceWs.close();
		await new Promise((r) => setTimeout(r, 20));
	});
});

describe("PressureSenseRelay forwardCommand RPC", () => {
	it("rejects a non-gated cmd", async () => {
		const id = env.RELAY.idFromName("test-forward-badcmd-" + Math.random());
		const stub = env.RELAY.get(id);
		const result = await stub.forwardCommand({ cmd: "getSchedule" });
		expect(result).toEqual({ ok: false, reason: "bad-command" });
	});

	it("reports device-offline when no device is connected", async () => {
		const id = env.RELAY.idFromName("test-forward-offline-" + Math.random());
		const stub = env.RELAY.get(id);
		const result = await stub.forwardCommand({ cmd: "saveSchedule", controllers: [] });
		expect(result).toEqual({ ok: false, reason: "device-offline" });
	});

	it("forwards to a connected device", async () => {
		const id = env.RELAY.idFromName("test-forward-ok-" + Math.random());
		const stub = env.RELAY.get(id);
		const deviceRes = await stub.fetch(new Request("http://x/device", { headers: { Upgrade: "websocket" } }));
		const deviceWs = deviceRes.webSocket;
		deviceWs.accept();

		let received = null;
		deviceWs.addEventListener("message", (evt) => { received = JSON.parse(evt.data); });

		const result = await stub.forwardCommand({ cmd: "setSchedulesEnabled", enabled: false });
		expect(result).toEqual({ ok: true });
		await new Promise((r) => setTimeout(r, 20));
		expect(received).toEqual({ cmd: "setSchedulesEnabled", enabled: false });

		deviceWs.close();
		await new Promise((r) => setTimeout(r, 20));
	});
});

describe("PressureSenseRelay /ws allow-list", () => {
	it("does not forward a mutating cmd sent directly over /ws, and tells the browser why", async () => {
		const id = env.RELAY.idFromName("test-ws-allowlist-" + Math.random());
		const stub = env.RELAY.get(id);

		const deviceRes = await stub.fetch(new Request("http://x/device", { headers: { Upgrade: "websocket" } }));
		const deviceWs = deviceRes.webSocket;
		deviceWs.accept();

		const browserRes = await stub.fetch(new Request("http://x/ws", { headers: { Upgrade: "websocket" } }));
		const browserWs = browserRes.webSocket;
		browserWs.accept();

		let deviceReceived = false;
		deviceWs.addEventListener("message", () => { deviceReceived = true; });

		let errorMsg = null;
		browserWs.addEventListener("message", (evt) => {
			const m = JSON.parse(evt.data);
			if (m.type === "error") errorMsg = m;
		});

		browserWs.send(JSON.stringify({ cmd: "manualZone", action: "start", controller: "yard", znumber: "1" }));
		await new Promise((r) => setTimeout(r, 50));

		expect(deviceReceived).toBe(false);
		expect(errorMsg).toEqual({ type: "error", cmd: "manualZone", reason: "not-allowed-via-ws" });

		deviceWs.close();
		browserWs.close();
		await new Promise((r) => setTimeout(r, 20));
	});

	it("still forwards getSchedule to the device over /ws (read-only, no cookie needed)", async () => {
		const id = env.RELAY.idFromName("test-ws-allowlist-read-" + Math.random());
		const stub = env.RELAY.get(id);

		const deviceRes = await stub.fetch(new Request("http://x/device", { headers: { Upgrade: "websocket" } }));
		const deviceWs = deviceRes.webSocket;
		deviceWs.accept();

		const browserRes = await stub.fetch(new Request("http://x/ws", { headers: { Upgrade: "websocket" } }));
		const browserWs = browserRes.webSocket;
		browserWs.accept();

		let received = null;
		deviceWs.addEventListener("message", (evt) => { received = JSON.parse(evt.data); });

		browserWs.send(JSON.stringify({ cmd: "getSchedule" }));
		await new Promise((r) => setTimeout(r, 50));

		expect(received).toEqual({ cmd: "getSchedule" });

		deviceWs.close();
		browserWs.close();
		await new Promise((r) => setTimeout(r, 20));
	});
});

describe("PressureSenseRelay chart history", () => {
	it("records sensorUpdate readings from the device socket and serves them to a browser via getHistory", async () => {
		const id = env.RELAY.idFromName("test-history-" + Math.random());
		const stub = env.RELAY.get(id);

		const deviceRes = await stub.fetch(new Request("http://x/device", { headers: { Upgrade: "websocket" } }));
		const deviceWs = deviceRes.webSocket;
		deviceWs.accept();

		const browserRes = await stub.fetch(new Request("http://x/ws", { headers: { Upgrade: "websocket" } }));
		const browserWs = browserRes.webSocket;
		browserWs.accept();

		let resolveHistory;
		const historyPromise = new Promise((resolve) => { resolveHistory = resolve; });
		browserWs.addEventListener("message", (evt) => {
			const m = JSON.parse(evt.data);
			if (m.type === "history") resolveHistory(m);
		});

		deviceWs.send(JSON.stringify({ type: "sensorUpdate", psi: 42.5, zoneAvgPsi: 40 }));
		// Let the DO's message handler (SQL insert) run before asking for history.
		await new Promise((r) => setTimeout(r, 50));

		browserWs.send(JSON.stringify({ cmd: "getHistory" }));
		const history = await historyPromise;

		expect(history.points.length).toBeGreaterThanOrEqual(1);
		expect(history.points[history.points.length - 1].psi).toBe(42.5);
		expect(history.points[history.points.length - 1].zoneAvgPsi).toBe(40);

		deviceWs.close();
		browserWs.close();
		await new Promise((r) => setTimeout(r, 20));
	});

	it("records zoneNumber/controller/allOff alongside each sensorUpdate row", async () => {
		const id = env.RELAY.idFromName("test-history-zone-" + Math.random());
		const stub = env.RELAY.get(id);

		const deviceRes = await stub.fetch(new Request("http://x/device", { headers: { Upgrade: "websocket" } }));
		const deviceWs = deviceRes.webSocket;
		deviceWs.accept();

		const browserRes = await stub.fetch(new Request("http://x/ws", { headers: { Upgrade: "websocket" } }));
		const browserWs = browserRes.webSocket;
		browserWs.accept();

		let resolveHistory;
		const historyPromise = new Promise((resolve) => { resolveHistory = resolve; });
		browserWs.addEventListener("message", (evt) => {
			const m = JSON.parse(evt.data);
			if (m.type === "history") resolveHistory(m);
		});

		deviceWs.send(JSON.stringify({
			type: "sensorUpdate", psi: 44.1, zoneAvgPsi: 45, zoneNumber: "3", controller: "Yard", allOff: false
		}));
		await new Promise((r) => setTimeout(r, 50));

		browserWs.send(JSON.stringify({ cmd: "getHistory" }));
		const history = await historyPromise;

		const row = history.points[history.points.length - 1];
		expect(row.zoneNumber).toBe("3");
		expect(row.controller).toBe("yard");
		expect(row.allOff).toBe(0);

		deviceWs.close();
		browserWs.close();
		await new Promise((r) => setTimeout(r, 20));
	});

	it("diffs manualZoneStatus into start/stop events, skipping the first message, and serves them via getHistory", async () => {
		const id = env.RELAY.idFromName("test-manual-events-" + Math.random());
		const stub = env.RELAY.get(id);

		const deviceRes = await stub.fetch(new Request("http://x/device", { headers: { Upgrade: "websocket" } }));
		const deviceWs = deviceRes.webSocket;
		deviceWs.accept();

		const browserRes = await stub.fetch(new Request("http://x/ws", { headers: { Upgrade: "websocket" } }));
		const browserWs = browserRes.webSocket;
		browserWs.accept();

		// First message: a zone already running -- should NOT produce a "start"
		// event (nothing to diff against yet).
		deviceWs.send(JSON.stringify({
			type: "manualZoneStatus",
			runs: [{ controller: "yard", relay: 5, remainingSec: 300, totalRunMinutes: 10, program: false, programLetter: "" }]
		}));
		await new Promise((r) => setTimeout(r, 30));

		// Second message: that run stopped -- should produce a "stop" event.
		deviceWs.send(JSON.stringify({ type: "manualZoneStatus", runs: [] }));
		await new Promise((r) => setTimeout(r, 30));

		let resolveHistory;
		const historyPromise = new Promise((resolve) => { resolveHistory = resolve; });
		browserWs.addEventListener("message", (evt) => {
			const m = JSON.parse(evt.data);
			if (m.type === "history") resolveHistory(m);
		});
		browserWs.send(JSON.stringify({ cmd: "getHistory" }));
		const history = await historyPromise;

		expect(history.manualEvents.length).toBe(1);
		expect(history.manualEvents[0].kind).toBe("stop");
		expect(history.manualEvents[0].relay).toBe(5);
		expect(history.manualEvents[0].controller).toBe("yard");

		deviceWs.close();
		browserWs.close();
		await new Promise((r) => setTimeout(r, 20));
	});

	it("does not forward getHistory to the device socket", async () => {
		const id = env.RELAY.idFromName("test-history-noforward-" + Math.random());
		const stub = env.RELAY.get(id);

		const deviceRes = await stub.fetch(new Request("http://x/device", { headers: { Upgrade: "websocket" } }));
		const deviceWs = deviceRes.webSocket;
		deviceWs.accept();

		const browserRes = await stub.fetch(new Request("http://x/ws", { headers: { Upgrade: "websocket" } }));
		const browserWs = browserRes.webSocket;
		browserWs.accept();

		let deviceReceived = false;
		deviceWs.addEventListener("message", () => { deviceReceived = true; });

		browserWs.send(JSON.stringify({ cmd: "getHistory" }));
		await new Promise((r) => setTimeout(r, 50));

		expect(deviceReceived).toBe(false);

		deviceWs.close();
		browserWs.close();
		await new Promise((r) => setTimeout(r, 20));
	});
});
