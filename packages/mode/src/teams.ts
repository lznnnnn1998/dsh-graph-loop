/**
 * Structural access to the optional Agent Teams service (`ctx.agentTeams`).
 *
 * Agent Teams ships as an experimental bundle; a mode must keep working on a
 * deployment that never composed it, so this module resolves the service by name at
 * call time and validates its shape instead of importing the package. That also keeps
 * the preset free of a dependency the host may not satisfy.
 * @module @dsh/explore-mode/teams
 */

/** The subset of a Team roster row this mode reads. */
export interface TeamMemberLike {
  readonly name: string
  /** `lead` for the team's own root; the lead is never a reuse target. */
  readonly role?: string
  /** `inactive` is the only state worth reusing. */
  readonly status?: string
  readonly description?: string
  readonly model?: string
}

/** The subset of the Agent Teams service this mode calls. */
export interface TeamsLike {
  /** Roster rows visible to one exact live Agent. */
  listMembers(agent: unknown): readonly TeamMemberLike[]
}

/** The context surface used to resolve an optional service by name. */
interface ServiceGetter {
  get?(name: string): unknown
}

/**
 * Resolve `ctx.agentTeams` when the deployment mounted it.
 * @param ctx - any Cordis context (the lookup walks the scope chain).
 * @returns the service, or undefined when Agent Teams is absent or malformed.
 */
export function teamsOf(ctx: unknown): TeamsLike | undefined {
  if (ctx === null || typeof ctx !== 'object') return undefined
  const getter = (ctx as ServiceGetter).get
  if (typeof getter !== 'function') return undefined
  let service: unknown
  try {
    service = getter.call(ctx, 'agentTeams')
  } catch {
    return undefined
  }
  if (service === null || typeof service !== 'object') return undefined
  if (typeof (service as { listMembers?: unknown }).listMembers !== 'function') return undefined
  return service as TeamsLike
}

/**
 * Read one Agent's roster without ever throwing into a prompt assembly or a tool call.
 * @param teams - resolved service.
 * @param agent - exact live Agent the caller is acting for.
 * @returns roster rows, or an empty array on any failure.
 */
export function listMembersSafely(teams: TeamsLike, agent: unknown): readonly TeamMemberLike[] {
  try {
    const members = teams.listMembers(agent)
    return Array.isArray(members) ? members : []
  } catch {
    return []
  }
}

/**
 * Drop rows that can never be a reuse target: the lead itself and malformed entries.
 * @param members - roster rows.
 * @returns teammates only.
 */
export function teammates(members: readonly TeamMemberLike[]): TeamMemberLike[] {
  return members.filter(member => member.role !== 'lead' && typeof member.name === 'string' && member.name.length > 0)
}
