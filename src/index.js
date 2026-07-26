// PressureSense App Worker.
//
// Endpoints:
//   GET  /            — dashboard (redirects to /login.html if no session)
//   POST /login       — check DASHBOARD_PASSWORD, issue signed session cookie
//   POST /logout      — clear the session cookie
//   GET  /ws          — browser live socket; requires a valid session cookie
//   GET  /device      — Indoor unit's socket; requires the RELAY_TOKEN bearer header
//   (all other paths) — served from static assets (login.html, style.css, etc.)
//
// /ws and /device both route into one Durable Object holding the device socket
// + N browser sockets, forwarding frames between them.

const SESSION_HOURS = 24;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- Relay subdomain: device traffic only, nothing else public ----
    if (url.hostname === "relay.pressure-sense.app" && url.pathname !== "/device") {
      return new Response("Not found", { status: 404 });
    }

    // ---- Device socket: RELAY_TOKEN bearer header ----
    if (url.pathname === "/device") {
      const auth = request.headers.get("Authorization") || "";
      if (!safeEqual(auth, "Bearer " + env.RELAY_TOKEN)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = env.RELAY.idFromName("singleton");
      return env.RELAY.get(id).fetch(request);
    }

    // ---- Login: password -> signed session cookie ----
    if (url.pathname === "/login" && request.method === "POST") {
      const { password } = await request.json().catch(() => ({}));
      //console.log("[login] got password len:", password ? password.length : "none");
      //console.log("[login] stored secret len:", env.DASHBOARD_PASSWORD ? env.DASHBOARD_PASSWORD.length : "UNDEFINED");
      //console.log("[login] match:", password === env.DASHBOARD_PASSWORD);
      if (!password || !safeEqual(password, env.DASHBOARD_PASSWORD)) {
        return new Response("Invalid password", { status: 401 });
      }
      const cookie = await makeSessionCookie(env.SESSION_KEY);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
      });
    }

    // ---- Logout: clear the cookie ----
    if (url.pathname === "/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "ps_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
        },
      });
    }

    // ---- Browser live socket: valid session cookie ----
    if (url.pathname === "/ws") {
      const token = readCookie(request.headers.get("Cookie") || "", "ps_session");
      if (!token || !(await verifySession(token, env.SESSION_KEY))) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = env.RELAY.idFromName("singleton");
      return env.RELAY.get(id).fetch(request);
    }

    // ---- Dashboard root: gate behind a session, else send to login ----
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const token = readCookie(request.headers.get("Cookie") || "", "ps_session");
      if (!token || !(await verifySession(token, env.SESSION_KEY))) {
        return Response.redirect(url.origin + "/login.html", 302);
      }
      // Authenticated: fall through to static assets to serve index.html.
    }

    // ---- Everything else: static assets (login.html, css, js, favicon) ----
    return env.ASSETS.fetch(request);
  },
};

// ---- Durable Object: holds both sides, forwards between them ----
export class PressureSenseRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.device = null;
    this.browsers = new Set();
    // null until the first manualZoneStatus this DO instance has seen (skips
    // diffing on that one so an already-running zone doesn't get a false
    // "start" event -- mirrors the same guard the dashboard's own live
    // tracking uses).
    this.lastManualRuns = null;

    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS history (
         ts INTEGER NOT NULL,
         psi REAL NOT NULL,
         zoneAvgPsi REAL
       )`
    );
    this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts)`
    );
    // Added after the initial deploy, when the `history` table already
    // existed with just the three columns above -- SQLite has no
    // "ADD COLUMN IF NOT EXISTS", so this runs unconditionally on every
    // startup and just no-ops via catch once the column is already there
    // (on a brand-new DO instance, the CREATE TABLE above hasn't created
    // these columns either, so the ALTERs apply cleanly there too).
    try { this.state.storage.sql.exec(`ALTER TABLE history ADD COLUMN zoneNumber TEXT`); } catch (_) {}
    try { this.state.storage.sql.exec(`ALTER TABLE history ADD COLUMN controller TEXT`); } catch (_) {}
    try { this.state.storage.sql.exec(`ALTER TABLE history ADD COLUMN allOff INTEGER`); } catch (_) {}

    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS manual_events (
         ts INTEGER NOT NULL,
         relay INTEGER NOT NULL,
         controller TEXT,
         kind TEXT NOT NULL
       )`
    );
    this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_manual_events_ts ON manual_events(ts)`
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    if (url.pathname === "/device") {
      if (this.device) { try { this.device.close(); } catch (_) {} }
      this.device = server;
      server.addEventListener("message", (evt) => {
        for (const b of this.browsers) { try { b.send(evt.data); } catch (_) {} }
        try {
          const m = JSON.parse(evt.data);
          if (m.type === "sensorUpdate" && typeof m.psi === "number") {
            const now = Date.now();
            // zoneNumber alone, not allOff: allOff is a pressure-recovery
            // heuristic on the master that can still read true for a while
            // after a scheduled zone starts (if pressure hasn't yet fallen
            // from a recent refill), which would record this sample as
            // zone-less even though a zone just started.
            const active = m.zoneNumber && String(m.zoneNumber) !== "0";
            this.state.storage.sql.exec(
              "INSERT INTO history (ts, psi, zoneAvgPsi, zoneNumber, controller, allOff) VALUES (?, ?, ?, ?, ?, ?)",
              now, m.psi, m.zoneAvgPsi ?? null,
              active ? String(m.zoneNumber) : null,
              active ? String(m.controller || "").toLowerCase() : null,
              m.allOff ? 1 : 0
            );
            this.state.storage.sql.exec(
              "DELETE FROM history WHERE ts < ?", now - 24 * 3600 * 1000
            );
          } else if (m.type === "manualZoneStatus" && Array.isArray(m.runs)) {
            // Diffs against the last-seen run list to record discrete
            // start/stop events (same algorithm the dashboard's own live
            // marker tracking uses), so a newly-connecting browser can
            // replay a whole day's manual start/stop markers via getHistory
            // instead of only seeing markers for transitions after it
            // happened to be connected.
            const now = Date.now();
            const runKey = (r) => String(r.controller || "").toLowerCase() + ":" + r.relay;
            if (this.lastManualRuns) {
              const newKeys = new Set(m.runs.map(runKey));
              const oldKeys = new Set(this.lastManualRuns.map(runKey));
              this.lastManualRuns.forEach((r) => {
                if (!newKeys.has(runKey(r))) {
                  this.state.storage.sql.exec(
                    "INSERT INTO manual_events (ts, relay, controller, kind) VALUES (?, ?, ?, 'stop')",
                    now, r.relay, String(r.controller || "").toLowerCase()
                  );
                }
              });
              // +1s vs the stop events above: a program advancing straight to
              // its next zone (no inter-zone delay) reports the old zone's
              // stop and the new zone's start in this same diff pass, so
              // without the nudge they'd land on the identical ts and the
              // replayed markers would stack/hide one on the client.
              m.runs.forEach((r) => {
                if (!oldKeys.has(runKey(r))) {
                  this.state.storage.sql.exec(
                    "INSERT INTO manual_events (ts, relay, controller, kind) VALUES (?, ?, ?, 'start')",
                    now + 1000, r.relay, String(r.controller || "").toLowerCase()
                  );
                }
              });
              this.state.storage.sql.exec(
                "DELETE FROM manual_events WHERE ts < ?", now - 24 * 3600 * 1000
              );
            }
            this.lastManualRuns = m.runs;
          }
        } catch (_) { /* not JSON / not a type we record -- already forwarded above */ }
      });
      server.addEventListener("close", () => { this.device = null; });
      server.addEventListener("error", () => { this.device = null; });
    } else {
      this.browsers.add(server);
      server.addEventListener("message", (evt) => {
        let cmd = null;
        try { cmd = JSON.parse(evt.data); } catch (_) {}
        if (cmd && cmd.cmd === "getHistory") {
          const rows = this.state.storage.sql
            .exec("SELECT ts, psi, zoneAvgPsi, zoneNumber, controller, allOff FROM history ORDER BY ts ASC")
            .toArray();
          const manualEvents = this.state.storage.sql
            .exec("SELECT ts, relay, controller, kind FROM manual_events ORDER BY ts ASC")
            .toArray();
          try {
            server.send(JSON.stringify({ type: "history", points: rows, manualEvents }));
          } catch (_) {}
          return;
        }
        if (this.device) {
          try { this.device.send(evt.data); } catch (_) {}
        } else if (cmd && cmd.cmd) {
          try { server.send(JSON.stringify({ type: "error", cmd: cmd.cmd, reason: "device-offline" })); } catch (_) {}
        }
      });
      server.addEventListener("close", () => { this.browsers.delete(server); });
      server.addEventListener("error", () => { this.browsers.delete(server); });
    }

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ---- Session helpers (HMAC-signed, no storage) ----
async function makeSessionCookie(keyStr) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = `${exp}`;
  const sig = await hmac(keyStr, payload);
  const token = `${payload}.${sig}`;
  return `ps_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

async function verifySession(token, keyStr) {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, await hmac(keyStr, payload))) return false;
  const exp = parseInt(payload, 10);
  return Number.isFinite(exp) && Date.now() < exp;
}

async function hmac(keyStr, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(header, name) {
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return v;
  }
  return null;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
