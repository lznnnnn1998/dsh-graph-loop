/**
 * Root carrier for the Web Graph tab.
 *
 * The host half is intentionally empty: the package's `dsh.client` bundle adds
 * one `conversation.view` tab next to Chat and Trajectory and reads the
 * graph-chat HTTP API. Keeping it a separate package gives the client module
 * system exactly one active loader source for this package.
 */
export const name = 'explore-graph-ui'

/** No host-side registrations. */
export function apply(): void {
  // no-op
}
