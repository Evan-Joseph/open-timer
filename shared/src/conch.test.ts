import { describe, expect, it } from 'vitest';
import { buildConchContext, parseConchLlmOutput } from './conch.js';
import type { ActiveSegmentRow, SessionRow, SubjectDef } from './types.js';

const projects: SubjectDef[] = [
  { id: 'release', displayName: 'Release', aggregateGroup: 'Work', colorId: 'blue', sortOrder: 1 },
  { id: 'backlog', displayName: 'Backlog', aggregateGroup: 'Work', colorId: 'teal', sortOrder: 2 },
];

describe('AI assistant context', () => {
  it('uses runtime projects and keeps their order while parsing recommendations', () => {
    const now = Date.UTC(2026, 0, 3);
    const session: SessionRow = { id: 's', userId: 'owner', subjectId: 'release', status: 'stopped', intentNote: 'review deployment plan', endNote: null, endReason: 'manual', startedAtMs: now - 3_600_000, endedAtMs: now - 1_800_000, activeSeconds: 1800, createdAtMs: now - 3_600_000 };
    const segment: ActiveSegmentRow = { sessionId: 's', startedAtMs: session.startedAtMs, endedAtMs: session.endedAtMs };
    const context = buildConchContext({ nowMs: now, window: '7d', sessions: [session], segmentsBySession: new Map([['s', [segment]]]), minSegmentMs: 0, projects });
    expect(context.userPrompt).toContain('Release (release)');
    expect(context.userPrompt).toContain('Backlog');
    const recs = parseConchLlmOutput(JSON.stringify({ subjects: [
      { subject_id: 'release', next_action: 'verify release notes', action_kind: 'other', rationale: 'recent work', confidence: 'high' },
    ] }), context.active);
    expect(recs?.map((rec) => rec.subject_id)).toEqual(['release']);
  });
});
