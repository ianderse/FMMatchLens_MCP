// Review checker tests. EVERY RESPONSE BELOW IS A SYNTHETIC, HAND-WRITTEN SAMPLE: none is a transcript of a language
// model. The tool results they are checked against are real outputs of the real server on a synthetic recording.
// The checker is an evaluation tool for saved transcripts, not a CI golden test; these tests check the checker itself.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkReview, collectEvidence } from '@fmmi/mcp'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { connect, seedSynthetic } from '../support/mcp.ts'

afterAll(cleanupAll)

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'review-check.mts')

async function evidence() {
  const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham' })
  const seed = await seedSynthetic(sc.synth)
  const c = await connect(seed.home)
  const records: unknown[] = []
  const rec = async (tool: string, args: Record<string, unknown>) => { const r = await c.call(tool, args); records.push({ tool, arguments: args, result: r.raw }); return r }
  await rec('list_matches', {})
  const sum = await rec('get_match_summary', { matchId: seed.matchId })
  const players = sum.data.summary.roster.players as Array<{ name: string; playerId: string }>
  const striker = players.find((p) => p.name === 'Away Player 9')!, sub = players.find((p) => p.name === 'Away Player 11')!
  const svc = await rec('get_striker_service', { matchId: seed.matchId, playerId: striker.playerId, comparePlayerId: sub.playerId, recordingRevisionId: seed.revisionId, window: { from: '2:11124', to: '2:21000' } })
  await c.close()
  const w = svc.data.window
  return { seed, striker, sub, records, svc: svc.data, attempts: svc.data.service.subject.aerial.attempts as number, won: svc.data.service.subject.aerial.won as number, from: `${w.from.period}:${w.from.tick}`, to: `${w.to.period}:${w.to.tick}`, minutes: `${Math.round(w.display.fromMinute)}-${Math.round(w.display.toMinute)} minutes` }
}

type Ev = Awaited<ReturnType<typeof evidence>>

/** SYNTHETIC SAMPLE (hand-written; not model output). A compliant five-part review citing only returned ids. */
function goodReview(e: Ev, o: { action?: string; facts?: string; extra?: string; headings?: string[] } = {}): string {
  const h = o.headings ?? ['1. Facts', '2. Interpretation', '3. Alternative explanations', '4. Action', '5. Confidence and what to watch next']
  return [
    '<!-- SYNTHETIC SAMPLE: hand-written for the review checker tests, not a language-model transcript -->',
    `## ${h[0]}`,
    o.facts ?? `- Match ${e.seed.matchId}, revision ${e.seed.revisionId}: ${e.striker.name} (${e.striker.playerId}) won ${e.won} of ${e.attempts} aerial duels (metric \`aerial_win_pct\`) in window ${e.from} to ${e.to} (${e.minutes}).`,
    `- ${e.sub.name} (${e.sub.playerId}) is the comparator in the same window.`,
    `## ${h[1]}`,
    'Hypothesis: long aerial deliveries to the striker may be less effective than ground passes. The counts do not establish this.',
    `## ${h[2]}`,
    'Opposition centre-backs, the score state and a small sample could each explain the aerial results; the data cannot separate them.',
    `## ${h[3]}`,
    o.action ?? 'Try one change next match: reduce long deliveries to the striker. Signal to watch: aerial attempts per 90. Downside: less territory.',
    `## ${h[4]}`,
    'Confidence is low: the capture is observational and one match. Watch aerial attempts per 90 next match.',
    o.extra ?? '',
  ].join('\n')
}

describe('review checker (synthetic samples)', () => {
  it('AC4 a compliant synthetic review of the striker-service question passes: five sections, one action, every cited id, metric and window present in the tool results', async () => {
    const e = await evidence()
    // the question is answerable from the returned results: the striker's 0/7 aerial duels and the gate status
    expect(e.attempts).toBe(2) // the scripted striker lost 2 of his 7 duels inside this window
    expect(e.won).toBe(0)
    const r = checkReview(goodReview(e), e.records)
    expect(r.failures).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.sections.found.map((s) => s.key)).toEqual(['facts', 'interpretation', 'alternatives', 'action', 'confidence'])
    expect(r.action).toMatchObject({ units: 1, withheld: false })
    expect(r.citations.ids.cited).toEqual(expect.arrayContaining([e.seed.matchId, e.seed.revisionId, e.striker.playerId, e.sub.playerId]))
    expect(r.citations.metrics.cited).toContain('aerial_win_pct')
    expect(r.citations.windows.cited).toEqual(expect.arrayContaining([e.from, e.to]))
    expect(r.citations.windows.missing).toEqual([])
  })

  it('AC4 a review that withholds its action and says why passes', async () => {
    const e = await evidence()
    const r = checkReview(goodReview(e, { action: 'No action is recommended: the recipient evidence is inadequate and this is one observational match.\n\nThe passing and aerial counts above are the available facts.' }), e.records)
    expect(r.ok, r.failures.join()).toBe(true)
    expect(r.action).toMatchObject({ withheld: true })
  })

  it('AC4 the checker also reads the results as saved MCP CallToolResults, bare payloads and text-only content', async () => {
    const e = await evidence()
    const raw = e.records.map((x) => (x as { result: unknown }).result)
    expect(checkReview(goodReview(e), raw).ok).toBe(true)
    const payloads = raw.map((r) => (r as { structuredContent: unknown }).structuredContent)
    expect(checkReview(goodReview(e), payloads).ok).toBe(true)
    const textOnly = raw.map((r) => ({ content: (r as { content: unknown }).content }))
    expect(checkReview(goodReview(e), textOnly).ok).toBe(true)
    expect(collectEvidence(textOnly).ids.has(e.seed.matchId)).toBe(true)
  })

  it('AC4 fails when a section is missing, duplicated or out of order', async () => {
    const e = await evidence()
    const noAlt = goodReview(e).replace(/## 3\. Alternative explanations\n[^\n]*\n/, '')
    const r1 = checkReview(noAlt, e.records)
    expect(r1.ok).toBe(false)
    expect(r1.failures).toContain('missing_sections: alternatives')
    const dup = checkReview(goodReview(e, { extra: '## 1. Facts\nMore facts.' }), e.records)
    expect(dup.failures).toContain('duplicated_sections: facts')
    const order = checkReview(goodReview(e, { headings: ['1. Facts', '3. Alternative explanations', '2. Interpretation', '4. Action', '5. Confidence'] }), e.records)
    expect(order.failures).toContain('sections_out_of_order')
    expect(checkReview('Just a paragraph with no structure.', e.records).failures[0]).toMatch(/missing_sections/)
  })

  it('AC4 fails when the Action section holds more than one action (list items or paragraphs), unless it withholds', async () => {
    const e = await evidence()
    const list = checkReview(goodReview(e, { action: '- Move the striker deeper.\n- Switch to a wider formation.' }), e.records)
    expect(list.ok).toBe(false)
    expect(list.failures).toContain('more_than_one_action: 2 items in the Action section')
    const numbered = checkReview(goodReview(e, { action: '1. Change the striker.\n2. Change the formation.\n3. Change the mentality.' }), e.records)
    expect(numbered.failures.join()).toMatch(/more_than_one_action: 3/)
    const paras = checkReview(goodReview(e, { action: 'Change the striker.\n\nAlso change the formation.' }), e.records)
    expect(paras.failures.join()).toMatch(/more_than_one_action: 2/)
    const empty = checkReview(goodReview(e, { action: '' }), e.records)
    expect(empty.failures.join()).toMatch(/action_section_empty/)
    const withheldList = checkReview(goodReview(e, { action: 'No action is recommended.\n- reason one\n- reason two' }), e.records)
    expect(withheldList.failures).toContain('withheld_but_lists_several_items')
  })

  it('AC4 fails when a cited id, metric or window is not in the tool results', async () => {
    const e = await evidence()
    const fakeId = checkReview(goodReview(e, { facts: `- Player p_ffffffffffff won 0 of 7 in match ${e.seed.matchId}.` }), e.records)
    expect(fakeId.failures).toContain('ids_not_in_tool_results: p_ffffffffffff')
    const fakeMatch = checkReview(goodReview(e, { facts: '- In match m_aaaaaaaaaaaaaaaa the striker won 0 of 7.' }), e.records)
    expect(fakeMatch.failures.join()).toMatch(/ids_not_in_tool_results: m_aaaaaaaaaaaaaaaa/)
    const fakeMetric = checkReview(goodReview(e, { facts: `- Match ${e.seed.matchId}: the isolation score was low (\`isolation_score\`).` }), e.records)
    expect(fakeMetric.failures).toContain('metrics_not_in_tool_results: isolation_score')
    // a registry metric the tools did not report in these results is not citable either
    const unreported = checkReview(goodReview(e, { facts: `- Match ${e.seed.matchId}: see passing_network_link for the links.` }), e.records)
    expect(unreported.failures).toContain('metrics_not_in_tool_results: passing_network_link')
    const fakeWindow = checkReview(goodReview(e, { facts: `- Match ${e.seed.matchId}: over window 2:99999 to ${e.to} nothing changed.` }), e.records)
    expect(fakeWindow.failures).toContain('windows_not_in_tool_results: 2:99999')
    const fakeMinutes = checkReview(goodReview(e, { facts: `- Match ${e.seed.matchId}: between 10-20 minutes the striker was quiet.` }), e.records)
    expect(fakeMinutes.failures).toContain('windows_not_in_tool_results: 10-20 min')
    const noIds = checkReview(goodReview(e, { facts: '- The striker won 0 of 7 aerial duels.' }).replace(/\(p_[0-9a-f]+\)/g, ''), e.records)
    expect(noIds.failures).toContain('facts_cite_no_ids')
    expect(checkReview(goodReview(e), []).failures.join()).toMatch(/no_tool_results/)
  })

  it('AC4 clock times such as 12:30 are not read as windows, and a minute window matches the returned display minutes to within rounding', async () => {
    const e = await evidence()
    const r = checkReview(goodReview(e, { facts: `- Match ${e.seed.matchId} was played at 12:30 local time; the striker ${e.striker.playerId} won 0 of 7 (${e.minutes}).` }), e.records)
    expect(r.failures).toEqual([])
    expect(r.citations.windows.cited).not.toContain('12:30')
  })

  it('AC4 the script runs on saved files: exit 0 for a pass, 1 for a failure, 2 for bad usage', async () => {
    const e = await evidence()
    const dir = tmp('fmmi-review-')
    const results = join(dir, 'results.json'), good = join(dir, 'good.md'), bad = join(dir, 'bad.md')
    writeFileSync(results, JSON.stringify(e.records))
    writeFileSync(good, goodReview(e))
    writeFileSync(bad, goodReview(e, { action: '- one\n- two' }))
    const run = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', SCRIPT, ...a], { encoding: 'utf8' })
    const ok = run('--response', good, '--results', results)
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toMatch(/^PASS/)
    const fail = run('--response', bad, '--results', results, '--json')
    expect(fail.status).toBe(1)
    expect(JSON.parse(fail.stdout).failures[0]).toMatch(/more_than_one_action/)
    expect(run('--response', good).status).toBe(2)
    expect(run('--response', join(dir, 'nope.md'), '--results', results).status).toBe(2)
  })

  it('answers that cite readable game minutes satisfy the checker: a span between two reported minutes passes, an invented span still fails, prose minutes are not windows', async () => {
    const e = await evidence()
    // the roster in get_match_summary now carries onAtMinute / offAtMinute beside the canonical onAt / offAt
    const withMinutes = [...e.records, { tool: 'get_player_match', arguments: {}, result: { structuredContent: { player: { participation: { lastOffGame: { minute: 74.33, label: "74'" } }, roleTimeline: [{ capturedTick: 9776, gameMinute: 40.73, gameLabel: "40'" }, { capturedTick: 14136, gameMinute: 56.55, gameLabel: "56'" }] } } } }]
    const ok = checkReview(goodReview(e, { extra: 'Prose: the role changed at about 40.7 min and again at about 56.6 min; he was off at 74.3 min (the span 41-57 min and 57-74 min).' }), withMinutes)
    expect(ok.failures).toEqual([])
    expect(ok.ok).toBe(true)
    const invented = checkReview(goodReview(e, { extra: 'Prose: between 12-33 min nothing happened.' }), withMinutes)
    expect(invented.failures.join()).toMatch(/windows_not_in_tool_results: 12-33 min/)
    expect(collectEvidence(withMinutes).minutes).toEqual(expect.arrayContaining([74.33, 40.73, 56.55]))
  })

})
