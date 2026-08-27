import type { SubjectDef, SubjectId, AggregateGroup } from './types.js';

/** Neutral projects inserted only into an empty new database. */
export const DEFAULT_PROJECTS: readonly SubjectDef[] = [
  { id: 'deep-work', displayName: 'Deep work', aggregateGroup: 'General', colorId: 'blue', sortOrder: 1 },
  { id: 'planning', displayName: 'Planning', aggregateGroup: 'General', colorId: 'teal', sortOrder: 2 },
  { id: 'meetings', displayName: 'Meetings', aggregateGroup: 'General', colorId: 'violet', sortOrder: 3 },
];

/** @deprecated Callers must use database-backed projects. Kept as a neutral test fallback. */
export const SUBJECTS = DEFAULT_PROJECTS;
export const SUBJECT_IDS: readonly SubjectId[] = DEFAULT_PROJECTS.map((s) => s.id);
export const AGGREGATE_GROUPS: readonly AggregateGroup[] = [];

export function subjectById(id: string): SubjectDef | undefined {
  return DEFAULT_PROJECTS.find((s) => s.id === id);
}

export function isSubjectId(v: string): v is SubjectId {
  return SUBJECT_IDS.includes(v as SubjectId);
}
