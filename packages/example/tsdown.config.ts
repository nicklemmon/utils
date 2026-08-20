import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",
  fixedExtension: false,
  sourcemap: true,
  dts: { sourcemap: true },
  attw: { profile: "esm-only", level: "error" },
  publint: true,
});
