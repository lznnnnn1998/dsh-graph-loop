/**
 * Unit tests for the explore mode's pure reuse scoring and the guard decision.
 *
 * No Cordis context, no model, no filesystem: everything here is a pure function so
 * the ranking and the "do not spawn a duplicate" rule can be pinned exactly.
 * Run with: `node --import tsx --test test/unit/mode-reuse.test.ts`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { policyText, rosterText } from '../../packages/mode/src/policy.ts'
import {
  GUARD_TEXT_FLOOR,
  GUARD_THRESHOLD,
  MAX_CANDIDATES,
  MIN_TASK_TOKENS,
  SUGGEST_THRESHOLD,
  duplicateSpawnDecision,
  duplicateSpawnReason,
  normalize,
  rankCandidates,
  scoreExecutor,
  shouldSuggestReuse,
  tokenOverlap,
  type ExecutorCandidate,
} from '../../packages/mode/src/reuse.ts'
import type { TeamMemberLike } from '../../packages/mode/src/teams.ts'
import { duplicateSpawnGuard } from '../../packages/mode/src/tools.ts'

const INACTIVE_LOGIN: ExecutorCandidate = {
  name: 'login-fixer',
  description: 'Fix login and authentication bugs in the web client',
  status: 'inactive',
}

const RUNNING_LOGIN: ExecutorCandidate = {
  name: 'login-runner',
  description: 'Fix login and authentication bugs in the web client',
  status: 'running',
}

const DOCS: ExecutorCandidate = {
  name: 'docs-writer',
  description: 'Write and maintain the user documentation',
  status: 'inactive',
}

test('normalize lowercases, splits punctuation, folds suffixes and drops noise', () => {
  assert.deepEqual(normalize('Fix the failing unit-tests!'), ['fail', 'unit'])
  assert.deepEqual(normalize('Auth-Service: login'), ['auth', 'service', 'login'])
  assert.deepEqual(normalize('blocking blocked stories'), ['block', 'block', 'story'])
  assert.deepEqual(normalize(''), [])
  assert.deepEqual(normalize('a an the of to'), [], 'stopwords and single letters carry no signal')
  assert.deepEqual(normalize('fix bug api docs tests'), [], 'generic intent words carry no routing signal')
})

test('normalize keeps CJK runs comparable as bigrams', () => {
  assert.deepEqual(normalize('修复登录问题'), ['修复', '复登', '登录', '录问', '问题'])
  assert.deepEqual(normalize('測'), ['測'], 'a one-character run stays a unigram')
})

test('tokenOverlap is containment, not symmetric Jaccard', () => {
  assert.equal(tokenOverlap('login bug', 'fix the login bug'), 1)
  assert.equal(tokenOverlap('login bug dashboard', 'fix the login bug'), 1 / 2)
  assert.equal(tokenOverlap('deploy kubernetes', 'write documentation'), 0)
  assert.equal(tokenOverlap('fix the tests', 'update the docs bug'), 0, 'generic words alone never overlap')
  assert.equal(tokenOverlap('', 'anything'), 0)
  assert.equal(tokenOverlap('anything', ''), 0)
  assert.equal(tokenOverlap('修复登录问题', '修复登录缺陷'), 3 / 5)
})

test('suffix folding makes plural and gerund task wording comparable', () => {
  assert.equal(tokenOverlap('fixing login authentication bugs', 'Fix login and authentication bugs'), 1)
  assert.equal(tokenOverlap('bugs', 'fix login authentication bugs'), 0, 'a generic word alone carries no signal')
})

test('scoreExecutor weights text over status and clamps to 0..1', () => {
  assert.equal(scoreExecutor('fix login bugs', INACTIVE_LOGIN), 1)
  assert.equal(scoreExecutor('fix login bugs', RUNNING_LOGIN), 0.838)
  assert.equal(scoreExecutor('fix login bugs', { ...INACTIVE_LOGIN, status: undefined }), 0.875)
  assert.equal(scoreExecutor('deploy kubernetes', INACTIVE_LOGIN), 0.25)
  assert.equal(scoreExecutor('deploy kubernetes', { ...DOCS, status: 'failed' }), 0)
  assert.equal(scoreExecutor('fix login bugs', { name: 'anything' }), 0.125, 'unknown status keeps half the status term')
})

test('rankCandidates sorts by score then name and never mutates the input', () => {
  const input = [DOCS, INACTIVE_LOGIN]
  const ranked = rankCandidates('fix login bug', input)
  assert.deepEqual(ranked.map(candidate => candidate.name), ['login-fixer', 'docs-writer'])
  assert.deepEqual(input.map(candidate => candidate.name), ['docs-writer', 'login-fixer'])
  const tie = rankCandidates('docs', [
    { name: 'b-docs', description: 'docs', status: 'inactive' },
    { name: 'a-docs', description: 'docs', status: 'inactive' },
  ])
  assert.deepEqual(tie.map(candidate => candidate.name), ['a-docs', 'b-docs'])
})

test('shouldSuggestReuse keeps only idle candidates above the threshold', () => {
  const ranked = shouldSuggestReuse('fix login bug', [INACTIVE_LOGIN, RUNNING_LOGIN, DOCS])
  assert.deepEqual(ranked.map(candidate => candidate.name), ['login-fixer'])
  assert.ok(ranked[0]!.score >= SUGGEST_THRESHOLD)
  assert.deepEqual(shouldSuggestReuse('fix login bug', [RUNNING_LOGIN]), [], 'a busy teammate is not a reuse target')
  assert.deepEqual(shouldSuggestReuse('deploy kubernetes', [INACTIVE_LOGIN, DOCS]), [])
  assert.equal(shouldSuggestReuse('fix login bug', [INACTIVE_LOGIN, RUNNING_LOGIN], 0, MAX_CANDIDATES).length, 1)
})

test('duplicateSpawnDecision denies a matching idle teammate', () => {
  const decision = duplicateSpawnDecision('fix login bug', [INACTIVE_LOGIN])
  assert.equal(decision.deny, true)
  assert.deepEqual(decision.matches.map(match => match.name), ['login-fixer'])
  assert.match(decision.reason ?? '', /An idle teammate matches this task: login-fixer/)
  assert.match(decision.reason ?? '', /Reuse via send_message/)
  assert.match(decision.reason ?? '', /clearly different name\/description/)
})

test('duplicateSpawnDecision allows the spawn in every non-duplicate case', () => {
  assert.equal(duplicateSpawnDecision('fix login bug', [INACTIVE_LOGIN], GUARD_THRESHOLD, false).deny, false)
  assert.equal(duplicateSpawnDecision('fix login bug', [RUNNING_LOGIN]).deny, false, 'only idle teammates are reusable')
  assert.equal(duplicateSpawnDecision('tests', [INACTIVE_LOGIN]).deny, false, 'one-word tasks are too ambiguous')
  assert.equal(duplicateSpawnDecision('login', [INACTIVE_LOGIN]).deny, false, 'one-word tasks are too ambiguous')
  assert.equal(duplicateSpawnDecision('login deploy dashboard tests', [INACTIVE_LOGIN]).deny, false, 'weak matches do not block')
  assert.equal(duplicateSpawnDecision('deploy kubernetes', [INACTIVE_LOGIN]).deny, false, 'the idle bonus alone does not block')
  assert.equal(duplicateSpawnDecision('fix login bug', []).deny, false)
})

test('same generic words never justify blocking a spawn', () => {
  const genericOnly: ExecutorCandidate = {
    name: 'bug-fixer',
    description: 'Fix bugs, update the docs and test the api',
    status: 'inactive',
  }
  // Both sides reduce to no distinctive tokens even though they share five words.
  assert.deepEqual(normalize('fix bugs and test the api docs'), [])
  assert.equal(duplicateSpawnDecision('fix bugs and test the api docs', [genericOnly]).deny, false)
  assert.equal(duplicateSpawnDecision('update the docs and test the api', [genericOnly]).deny, false)
})

test('the idle-status bonus alone cannot cross the deny threshold', () => {
  assert.ok(MIN_TASK_TOKENS >= 2)
  assert.ok(GUARD_TEXT_FLOOR <= GUARD_THRESHOLD, 'the text floor is the guard rule, not a higher bar than the score')
  assert.equal(scoreExecutor('deploy kubernetes', INACTIVE_LOGIN), 0.25, 'an idle match with no text evidence scores 0.25')
  // A third of the tokens plus the 0.25 bonus reaches exactly the old 0.5 score
  // threshold; the text-only floor (0.5) rejects it because 1/3 < 0.5.
  assert.equal(scoreExecutor('login deploy dashboard', INACTIVE_LOGIN), GUARD_THRESHOLD)
  assert.equal(duplicateSpawnDecision('login deploy dashboard', [INACTIVE_LOGIN]).deny, false)
})

test('duplicateSpawnReason names every match', () => {
  const reason = duplicateSpawnReason([
    { name: 'a', description: '', status: 'inactive', score: 0.9 },
    { name: 'b', description: '', status: 'inactive', score: 0.8 },
  ])
  assert.match(reason, /a, b/)
})

test('policyText names the node and stays short', () => {
  const text = policyText('verify')
  assert.match(text, /current node: verify/)
  assert.match(text, /Graph policy/)
  assert.ok(text.length < 800, `policy section is ${text.length} chars`)
})

test('rosterText lists idle teammates only, one line each', () => {
  const members: TeamMemberLike[] = [
    { name: 'bundle-architect', role: 'lead', status: 'inactive', description: 'leads' },
    { name: 'login-fixer', role: 'teammate', status: 'inactive', description: 'fixes login bugs' },
    { name: 'busy-one', role: 'teammate', status: 'running', description: 'busy' },
  ]
  const text = rosterText(members)
  assert.match(text, /login-fixer: fixes login bugs/)
  assert.doesNotMatch(text, /bundle-architect/)
  assert.doesNotMatch(text, /busy-one/)
  assert.equal(text.split('\n').length, 2, 'heading plus one line')
})

test('rosterText is empty when nobody is idle and clips long descriptions', () => {
  assert.equal(rosterText([]), '')
  assert.equal(rosterText([{ name: 'busy', status: 'running' }]), '')
  const long = rosterText([{ name: 'chatty', status: 'inactive', description: 'x'.repeat(200) }])
  const line = long.split('\n')[1] ?? ''
  assert.ok(line.endsWith('...'), line)
  assert.ok(line.length <= 130, `line is ${line.length} chars`)
})

/** Minimal `ctx` whose only job is to answer `get('agentTeams')`. */
function fakeContext(roster: readonly TeamMemberLike[] | Error): Context {
  return {
    get(name: string): unknown {
      if (name !== 'agentTeams') return undefined
      if (roster instanceof Error) {
        return {
          listMembers(): never {
            throw roster
          },
        }
      }
      return { listMembers: () => roster }
    },
  } as unknown as Context
}

/** Minimal `spawn_teammate` execution the guard understands. */
function fakeSpawn(description: string, name = 'new-teammate'): ToolExecution {
  return {
    name: 'spawn_teammate',
    arguments: { name, description, prompt: 'do the thing' },
    agent: {},
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

test('duplicateSpawnGuard denies the duplicate and passes everything else through', () => {
  const ctx = fakeContext([
    { name: 'login-fixer', role: 'teammate', status: 'inactive', description: 'fix login and authentication bugs' },
  ])
  const denied = duplicateSpawnGuard(ctx, fakeSpawn('fix login authentication bugs'))
  assert.equal(denied?.kind, 'deny')
  assert.match(denied?.kind === 'deny' ? denied.reason : '', /login-fixer/)

  assert.equal(duplicateSpawnGuard(ctx, { ...fakeSpawn('x'), name: 'send_message' } as ToolExecution), undefined)
  assert.equal(duplicateSpawnGuard(fakeContext([]), fakeSpawn('fix login authentication bugs')), undefined)
  assert.equal(
    duplicateSpawnGuard(fakeContext(new Error('teams exploded')), fakeSpawn('fix login authentication bugs')),
    undefined,
    'a throwing roster must fail open',
  )
  assert.equal(
    duplicateSpawnGuard(ctx, fakeSpawn('fix login authentication bugs'), { blockDuplicateSpawn: false, reuseThreshold: GUARD_THRESHOLD }),
    undefined,
  )
  assert.equal(duplicateSpawnGuard(ctx, { ...fakeSpawn('x'), arguments: undefined } as unknown as ToolExecution), undefined)
})
