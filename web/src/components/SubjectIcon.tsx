/** 科目身份的图标编码：与中文名称、色彩共同使用；宽时间轴片段也可复用。 */

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
