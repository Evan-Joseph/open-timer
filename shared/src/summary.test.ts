import { describe, expect, it } from 'vitest';
import { buildDailySummary } from './summary.js';
import type { ActiveSegmentRow, SessionRow, SubjectDef } from './types.js';

const start = Date.UTC(2026, 0, 1, 16);
const projects: SubjectDef[] = [
  { id: 'delivery', displayName: 'Delivery', aggregateGroup: 'Work', colorId: 'blue', sortOrder: 1 },
  { id: 'retired', displayName: 'Retired', aggregateGroup: 'Work', colorId: 'teal', sortOrder: 2, archivedAtMs: start },
];

describe('dynamic project summary', () => {
  it('uses database project order and includes archived project history', () => {
    const session: SessionRow = { id: 's1', userId: 'owner', subjectId: 'retired', status: 'stopped', intentNote: null, endNote: null, endReason: 'manual', startedAtMs: start, endedAtMs: start + 3_600_000, activeSeconds: 3600, createdAtMs: start };
    const segment: ActiveSegmentRow = { sessionId: 's1', startedAtMs: start, endedAtMs: start + 3_600_000 };
    const result = buildDailySummary({ date: '2026-01-02', sessions: [session], segmentsBySession: new Map([['s1', [segment]]]), adjustments: [], revision: 1, generatedAtMs: start + 4_000_000, activeSession: null, activeSegments: [], minSegmentMs: 0, projects });
    expect(result.by_subject.map((entry) => entry.display_name)).toEqual(['Delivery', 'Retired']);
    expect(result.by_subject[1].active_seconds).toBe(3600);
    expect(result.aggregates).toEqual([{ group: 'Work', active_seconds: 3600 }]);
  });
});
