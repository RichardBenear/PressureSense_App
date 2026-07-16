import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("Hello World worker", () => {
	it("responds with Hello World! (unit style)", async () => {
		const request = new Request("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it("responds with Hello World! (integration style)", async () => {
		const response = await SELF.fetch("http://example.com");
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
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
