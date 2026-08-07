import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Contract and e2e files share one stateful GreenMail server, and several
    // mutate global folder state (the first draft CREATEs the Drafts folder;
    // session tests delete and recreate Archive). Files must therefore never
    // run concurrently: a CREATE landing inside another file's folder-list
    // snapshot window fails assertions that hold in isolation.
    fileParallelism: false,
  },
});
