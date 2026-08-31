/** 科目身份的第二编码：图标辅助颜色与中文名称，窄时间轴片段仍只保留颜色。 */

import { Braces, Cpu, Landmark, Languages, Network, Sigma, Terminal, type LucideProps } from 'lucide-react';

const ICONS = {
  math: Sigma,
  english: Languages,
  'data-structures': Braces,
  'computer-organization': Cpu,
  'operating-systems': Terminal,
  'computer-networks': Network,
  politics: Landmark,
} as const;

export default function SubjectIcon({ subjectId, className, ...props }: { subjectId: string } & Omit<LucideProps, 'ref'>) {
  const Icon = ICONS[subjectId as keyof typeof ICONS];
  return Icon ? <Icon className={`subject-icon${className ? ` ${className}` : ''}`} aria-hidden {...props} /> : null;
}
