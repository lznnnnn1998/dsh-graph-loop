/**
 * @dsh/explore-mode — skeleton entry.
 *
 * This package is a BUNDLE: the profile applies `cordis.patch.yml`, and only the
 * rows that file names are ever imported. This module exists so the package has
 * a resolvable `main`, and so a future host-side helper can live here.
 *
 * Recorded mode values are documented in `cordis.patch.yml` and in
 * `bundle/README.md`; the real kernel lives in `design/` (kernel.ts, matching.ts,
 * runtime.ts) and is not wired here yet.
 * @module @dsh/explore-mode
 */

/** Cordis plugin name (informational only — no row references this module). */
export const name = 'explore-mode'

/**
 * No-op plugin so the module is valid if a row ever names the bare package.
 * @param {import('@deepseek-ai/cordis').Context} _ctx - mounting context.
 */
export function apply(_ctx) {
  // The compose layer lives in ./registry, ./router, ./runtime; nothing to do here.
}

/** Rows this bundle inserts; kept next to the code for diagnostics. */
export const ROWS = Object.freeze([
  'graph-registry',
  'graph-router',
  'graph-runtime',
  'preset-explore',
])
