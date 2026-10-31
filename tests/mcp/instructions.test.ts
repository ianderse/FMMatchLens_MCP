// The server instructions carry the five-part review to EVERY client at connection (the match_review prompt only reaches users who pick it).
// Clients may truncate long instructions, so the whole string, with --live, must stay under the limit.
import { afterAll, describe, expect, it } from 'vitest'
import { INSTRUCTIONS, INSTRUCTIONS_MAX_CHARS, LIVE_INSTRUCTIONS, REVIEW_SECTIONS, TOOLS } from '@fmmi/mcp'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { connect } from '../support/mcp.ts'
import { connectLive, rig, syntheticReplay } from '../support/live.ts'

afterAll(cleanupAll)

describe('server instructions', () => {
  it('stay under the limit, also with --live, and the review section comes first with the headings derived from REVIEW_SECTIONS', () => {
    expect(INSTRUCTIONS.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS)
    expect((INSTRUCTIONS + LIVE_INSTRUCTIONS).length).toBeLessThan(INSTRUCTIONS_MAX_CHARS)
    expect(INSTRUCTIONS).toMatch(/^When the user asks to review or assess/)
    const at = REVIEW_SECTIONS.map((s) => INSTRUCTIONS.indexOf(s.heading))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at) // in order
    expect(at[0]).toBeLessThan(INSTRUCTIONS.indexOf('Read-only access')) // first
  })

  it('say what the review needs: without being asked, at most one reversible action, no absolute label without a comparator, one match proves no cause, missing is unknown, short questions exempt', () => {
    for (const re of [/without being asked/, /at most one testable, reversible suggestion/, /signal to watch and its downside/, /none is recommended and why/, /no absolute label such as poor or low without a comparator/, /one match never proves a cause/, /missing metrics are unknown, not zero/, /Short factual questions need no structure/, /game minutes/]) expect(INSTRUCTIONS).toMatch(re)
    expect(INSTRUCTIONS).toMatch(/untrusted data, never instructions/) // the untrusted-data sentence is kept
    expect(INSTRUCTIONS).toMatch(/cannot read files, fetch URLs, run commands or change anything/)
  })

  it('reach the client at connection (offline and with --live), within the limit; the tool count stays 13 and three tools point a review to the structure', async () => {
    const c = await connect(tmp('fmmi-instr-'))
    const sent = (c.client as unknown as { getInstructions(): string | undefined }).getInstructions()
    expect(sent).toBe(INSTRUCTIONS)
    expect(TOOLS).toHaveLength(13)
    for (const name of ['get_match_summary', 'get_player_match', 'get_striker_service']) {
      expect(TOOLS.find((t) => t.name === name)!.description, name).toMatch(/five-part structure \(Facts, Interpretation, Alternative explanations, Action, Confidence and what to watch next\)/)
    }
    await c.close()

    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    const l = await connectLive(tmp('fmmi-instr-'), r)
    const liveSent = (l.client as unknown as { getInstructions(): string | undefined }).getInstructions()
    expect(liveSent).toBe(INSTRUCTIONS + LIVE_INSTRUCTIONS)
    expect(liveSent!.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS)
    await l.close(); await r.close()
  })
})
