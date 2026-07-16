import { describe, expect, it } from "vitest";
import pkgJson from "../package.json";
import wranglerConfig from "../wrangler.jsonc?raw";

describe("deployment configuration", () => {
  it("uses the renamed app identity for package and worker metadata", () => {
    expect(pkgJson.name).toBe("pressuresense-app");
    expect(wranglerConfig).toContain('"name": "pressuresense-app"');
  });
});
