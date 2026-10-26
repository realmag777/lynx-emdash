import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	// Each test file builds the plugin into dist/; running files in parallel collides on Windows (EBUSY).
	test: { testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});
