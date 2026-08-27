import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/cli-impl.ts"],
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: { sourcemap: true },
  attw: { profile: "esm-only", level: "error" },
  publint: true,
});
