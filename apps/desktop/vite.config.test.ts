import { describe, expect, it } from "vitest";
import config from "./vite.config";

describe("renderer production configuration", () => {
  it("uses relative asset URLs for Electron file loading", () => {
    expect(config).toBeTypeOf("object");
    expect((config as { base?: string }).base).toBe("./");
  });
});
