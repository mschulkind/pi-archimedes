import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);

describe("consumed git package", () => {
  it("registers both session naming and the footer from its root manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    expect(manifest.pi.extensions).toEqual([
      "./packages/session-name/src/index.ts",
      "./packages/footer/src/index.ts",
    ]);
    for (const entry of manifest.pi.extensions) {
      expect(existsSync(fileURLToPath(new URL(entry, root)))).toBe(true);
    }
  });
});
