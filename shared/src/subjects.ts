import type { SubjectDef, SubjectId, AggregateGroup } from './types.js';

/**
 * 固定 7 科目（1+1+4+1）。显示名与机器 ID 分离，永不从自由文本反向解析。
 * 408 在计时层拆为四个真实模块，汇总层提供 408 聚合。
 */
export const SUBJECTS: readonly SubjectDef[] = [
  { id: 'math', displayName: '数学二', aggregateGroup: 'math', colorId: 'amber', sortOrder: 1 },
  { id: 'english', displayName: '英语二', aggregateGroup: 'english', colorId: 'teal', sortOrder: 2 },
  { id: 'data-structures', displayName: '数据结构', aggregateGroup: '408', colorId: 'blue', sortOrder: 3 },
  { id: 'computer-organization', displayName: '计算机组成原理', aggregateGroup: '408', colorId: 'indigo', sortOrder: 4 },
  { id: 'operating-systems', displayName: '操作系统', aggregateGroup: '408', colorId: 'violet', sortOrder: 5 },
  { id: 'computer-networks', displayName: '计算机网络', aggregateGroup: '408', colorId: 'cyan', sortOrder: 6 },
  { id: 'politics', displayName: '思想政治理论', aggregateGroup: 'politics', colorId: 'coral', sortOrder: 7 },
] as const;

export const SUBJECT_IDS: readonly SubjectId[] = SUBJECTS.map((s) => s.id);

export const AGGREGATE_GROUPS: readonly AggregateGroup[] = ['math', 'english', '408', 'politics'] as const;

export function subjectById(id: string): SubjectDef | undefined {
  return SUBJECTS.find((s) => s.id === id);
}

export function isSubjectId(v: string): v is SubjectId {
  return SUBJECT_IDS.includes(v as SubjectId);
}
