import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "@takazudo/zfb/zudo-react" } },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.dom.test.{ts,tsx}"],
    setupFiles: ["./tests/dom-setup.ts"],
  },
});
