/**
 * Web carrier for the graph loop: one Loader row that owns both the Graph tab
 * client bundle and the `/graph-chat` page/API host surface.
 *
 * client-modules rejects two active Loader sources for one client package, so the
 * host surface must share this package's single row rather than add its own.
 */
import type { Context } from '@deepseek-ai/cordis'
import { GraphChat, type Config } from './graph-chat.ts'

export type { Config }

export const name = 'explore-graph-ui'

/** The host surface needs the Web server plus the registries it reads. */
export const inject = ['webServer', 'sessions', 'agents']

/**
 * Mount the graph-chat page/API.
 * @param ctx - host context.
 * @param config - page path and the fallback route for new graph chats.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(GraphChat, config)
}
