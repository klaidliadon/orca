/**
 * Runs the node-environment test files on a host that cannot build the full suite.
 *
 * Deliberately not `config/vitest.config.ts`: that one pulls happy-dom, the renderer
 * aliases and two setup files. The tests this config is for import only node builtins,
 * vitest and local modules, so none of that applies to them — and on a constrained host
 * (a Synology NAS, in the case this was written for) the full toolchain will not install
 * at all, which used to mean those files ran nowhere.
 *
 * Why that matters beyond convenience: several suites guard permission-refusal cases on
 * `getuid() !== 0`. CI containers run as root, so those cases are skipped there and, with
 * no second lane, execute nowhere at all. Pointing this config at such a file from an
 * ordinary user account is what makes them run.
 *
 *   node_modules/vitest/vitest.mjs run --config vitest.node-only.config.ts \
 *     --reporter=verbose src/main/agent-hooks/installer-utils.test.ts
 *
 * Use `--reporter=verbose` and look for the case you care about: a skipped test still
 * counts toward "passed" in the summary line, so the count alone cannot tell you whether
 * the root-guarded assertion actually ran.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000
  }
})
