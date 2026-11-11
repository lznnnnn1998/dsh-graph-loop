/**
 * world.ts — observe the session workspace at a step boundary.
 *
 * A step's artifacts are attributed from its *effects*, not from what its tool
 * calls claim. The scheduler diffs two of its own observations of the session
 * workspace (path existence, size, mtime) and credits what appeared or changed.
 * Tool arguments may address an observed ref (a verifier locator), but they
 * cannot enumerate what the step produced; shell command text is never read
 * here or anywhere upstream of it.
 *
 * The walk is bounded and deterministic: sorted directory entries, no symlink
 * follow, a fixed set of dependency/VCS directories skipped, and entry/depth
 * caps. An incomplete observation credits nothing — a capped walk cannot tell
 * "unchanged" from "unobserved", so it must not certify a step.
 * @module dsh-graph-loop/world
 */

import { lstatSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** One regular file as the runtime observed it. */
export interface WorldFile {
  readonly size: number
  readonly mtimeMs: number
}

/** A bounded observation of a workspace root, keyed by absolute path. */
export interface WorldObservation {
  readonly root: string
  /** Regular, non-empty files only: an empty file is not an artifact. */
  readonly files: ReadonlyMap<string, WorldFile>
  /** False when a cap or an unreadable directory hid part of the tree. */
  readonly complete: boolean
}

/** A path that appeared or changed between two observations. */
export interface WorldChange {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

/**
 * Directories no step authors: version-control stores and dependency trees.
 * They are cost-only skips; nothing inside them is an artifact a step produced.
 */
const SKIP_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', '__pycache__'])

/** Observation bounds. Hitting either cap marks the observation incomplete. */
const MAX_ENTRIES = 20_000
const MAX_DEPTH = 12

function sortedNames(directory: string): string[] | undefined {
  try {
    return readdirSync(directory).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  } catch {
    return undefined
  }
}

/**
 * Observe a workspace root within fixed bounds.
 *
 * `lstatSync` (never `statSync`) means a symlink is skipped rather than followed:
 * a link into another tree is not a file this step produced, and following it
 * could leave the root or loop. A path that vanishes mid-walk is simply absent
 * from this observation; a cross-boundary change is what the next diff sees.
 * @param root - the session workspace root (absolute, or resolved against cwd).
 * @returns the bounded observation; `complete=false` when a cap was hit.
 */
export function observeWorld(root: string): WorldObservation {
  const absoluteRoot = resolve(root)
  const files = new Map<string, WorldFile>()
  let entries = 0
  let complete = true
  const walk = (directory: string, depth: number): void => {
    const names = sortedNames(directory)
    if (names === undefined) {
      // An unreadable directory hides a subtree: the observation cannot claim
      // that nothing changed inside it.
      complete = false
      return
    }
    for (const name of names) {
      entries += 1
      if (entries > MAX_ENTRIES) {
        complete = false
        return
      }
      const path = join(directory, name)
      let stat
      try {
        stat = lstatSync(path)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (SKIP_DIRECTORIES.has(name)) continue
        if (depth >= MAX_DEPTH) {
          complete = false
          continue
        }
        walk(path, depth + 1)
        if (!complete) return
        continue
      }
      if (!stat.isFile() || stat.size <= 0) continue
      files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  walk(absoluteRoot, 0)
  return { root: absoluteRoot, files, complete }
}

/**
 * Paths that appeared or changed between two observations.
 *
 * Deletions are not changes a step produced: a removed path cannot be an
 * artifact, and re-measuring prior refs after the step already covers a
 * verifier that deleted its evidence. `undefined` means the pair cannot be
 * trusted (different roots, or either observation incomplete), and the caller
 * must credit nothing.
 * @param before - the observation at the previous boundary, if any.
 * @param after - the observation at this boundary.
 * @returns changed regular files in stable path order, or undefined.
 */
export function diffWorld(
  before: WorldObservation | undefined,
  after: WorldObservation,
): readonly WorldChange[] | undefined {
  if (before === undefined || before.root !== after.root) return undefined
  if (!before.complete || !after.complete) return undefined
  const changes: WorldChange[] = []
  for (const [path, file] of after.files) {
    const previous = before.files.get(path)
    if (previous !== undefined && previous.size === file.size && previous.mtimeMs === file.mtimeMs) continue
    changes.push({ path, size: file.size, mtimeMs: file.mtimeMs })
  }
  return changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}
