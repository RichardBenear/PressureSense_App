import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				// Secrets aren't set via wrangler.jsonc (they're `wrangler secret put`
				// in real deployments) -- provide test-only values so /login and
				// /api/command can be exercised end-to-end.
				miniflare: {
					bindings: {
						DASHBOARD_PASSWORD: "test-password",
						SESSION_KEY: "test-session-key",
					},
				},
			},
		},
	},
});
