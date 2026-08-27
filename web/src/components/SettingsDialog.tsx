import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Maximize, X } from 'lucide-react';
import { setAnimationsEnabled, useAnimationsEnabled, useSettings, updateSettings } from '../lib/settings.js';
import { AMBIENT_LABELS } from '../lib/ambient.js';
import { detectDeviceRole, requestAppFullscreen } from '../lib/device.js';
import { apiDelete, apiGet, apiPost, apiPut, type SubjectApi } from '../lib/api.js';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  theme: string;
  onThemeChange: (t: string) => void;
  onLogout: () => Promise<void>;
  /** 只读监督态隐藏退出登录（本就没有登录会话） */
  isOwner: boolean;
  projects: SubjectApi[];
  onProjectsChanged: () => Promise<void>;
}

export default function SettingsDialog({ open, onOpenChange, theme, onThemeChange, onLogout, isOwner, projects, onProjectsChanged }: Props) {
  const settings = useSettings();
  const animationsOn = useAnimationsEnabled();
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** 进入全屏被浏览器拒绝时的可理解反馈（权限、iframe 沙箱或不支持） */
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [managedProjects, setManagedProjects] = useState<SubjectApi[]>(projects);
  const [projectName, setProjectName] = useState('');
  const [projectGroup, setProjectGroup] = useState('General');
  const [projectColor, setProjectColor] = useState('blue');
  const [projectOrder, setProjectOrder] = useState(100);
  const [projectMessage, setProjectMessage] = useState<string | null>(null);
  const [ai, setAi] = useState({ provider: 'siliconflow', api_base: 'https://api.siliconflow.cn/v1', model: '', api_key: '' });
  const [aiMessage, setAiMessage] = useState<string | null>(null);

  useEffect(() => setManagedProjects(projects), [projects]);
  const reloadProjects = async () => {
    setManagedProjects(await apiGet<SubjectApi[]>('/api/v1/projects?include_archived=true'));
    await onProjectsChanged();
  };
  const createProject = async () => {
    const display_name = projectName.trim();
    if (!display_name) return;
    const result = await apiPost('/api/v1/projects', {
      display_name,
      aggregate_group: projectGroup.trim() || 'General',
      color_id: projectColor,
      sort_order: projectOrder,
    });
    if (!result.ok) return setProjectMessage('无法创建项目，请重试。');
    setProjectName('');
    setProjectGroup('General');
    setProjectColor('blue');
    setProjectOrder(Math.max(100, ...managedProjects.map((project) => project.sort_order + 1)));
    await reloadProjects();
  };
  const updateProject = async (project: SubjectApi, patch: Partial<Pick<SubjectApi, 'display_name' | 'aggregate_group' | 'color_id' | 'sort_order'>>) => {
    const result = await apiPut(`/api/v1/projects/${encodeURIComponent(project.subject_id)}`, {
      display_name: patch.display_name?.trim() || project.display_name,
      aggregate_group: patch.aggregate_group?.trim() || project.aggregate_group || 'General',
      color_id: patch.color_id ?? project.color_id,
      sort_order: patch.sort_order ?? project.sort_order,
    });
    if (!result.ok) setProjectMessage('无法保存项目更改。');
    else await reloadProjects();
  };
  const archiveProject = async (project: SubjectApi) => {
    const result = await apiDelete(`/api/v1/projects/${encodeURIComponent(project.subject_id)}`);
    if (!result.ok) setProjectMessage('无法归档：请先结束该项目的活动计时。历史记录会被安全保留。');
    else await reloadProjects();
  };
  const saveAi = async () => {
    const result = await apiPut('/api/v1/ai-config', ai);
    setAiMessage(result.ok ? 'AI 助手配置已加密保存。' : '无法保存。请确认部署已设置 AI_CONFIG_ENCRYPTION_KEY，且配置有效。');
    if (result.ok) setAi((v) => ({ ...v, api_key: '' }));
  };

  const enterFullscreen = () => {
    setFullscreenError(null);
    if (requestAppFullscreen()) {
      onOpenChange(false);
    } else {
      setFullscreenError('浏览器拒绝了全屏请求。请改用 F11 或浏览器菜单进入全屏，应用会自动切换布局。');
    }
  };
  const deviceRole = detectDeviceRole();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <Dialog.Title className="dialog-title">设置</Dialog.Title>

          <div className="setting-row">
            <span className="setting-label">外观</span>
            <div className="seg-control" role="radiogroup" aria-label="主题">
              {[
                ['light', '浅色'],
                ['dark', '深色'],
                ['auto', '跟随系统'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={theme === value}
                  className={`seg-item ${theme === value ? 'active' : ''}`}
                  onClick={() => onThemeChange(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {isOwner && (
              <div className="setting-row">
                <span className="setting-label">项目</span>
                <p className="setting-hint">项目存储在此部署的数据库中。归档会保留历史会话，不会硬删除数据。</p>
                <div className="project-list">
                  {managedProjects.map((project) => (
                    <div className="project-item" key={project.subject_id}>
                      <input
                        aria-label={`${project.display_name} 名称`}
                        defaultValue={project.display_name}
                        disabled={Boolean(project.archived_at)}
                        onBlur={(event) => void updateProject(project, { display_name: event.target.value })}
                      />
                      <input
                        aria-label={`${project.display_name} 分组`}
                        defaultValue={project.aggregate_group || 'General'}
                        disabled={Boolean(project.archived_at)}
                        maxLength={60}
                        onBlur={(event) => void updateProject(project, { aggregate_group: event.target.value })}
                      />
                      <select
                        aria-label={`${project.display_name} 颜色`}
                        defaultValue={project.color_id}
                        disabled={Boolean(project.archived_at)}
                        onChange={(event) => void updateProject(project, { color_id: event.target.value })}
                      >
                        {['blue', 'teal', 'violet', 'amber', 'coral', 'indigo', 'cyan'].map((color) => <option value={color} key={color}>{color}</option>)}
                      </select>
                      <input
                        aria-label={`${project.display_name} 排序`}
                        defaultValue={project.sort_order}
                        disabled={Boolean(project.archived_at)}
                        min={0}
                        max={10000}
                        type="number"
                        onBlur={(event) => void updateProject(project, { sort_order: Number(event.target.value) || 0 })}
                      />
                      {project.archived_at ? <span className="setting-hint">已归档</span> : <button className="ghost-btn" onClick={() => void archiveProject(project)}>归档</button>}
                    </div>
                  ))}
                </div>
                <div className="project-item">
                  <input aria-label="新项目名称" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="新项目名称" maxLength={80} />
                  <input aria-label="新项目分组" value={projectGroup} onChange={(e) => setProjectGroup(e.target.value)} placeholder="分组（例如 Work）" maxLength={60} />
                  <select aria-label="新项目颜色" value={projectColor} onChange={(e) => setProjectColor(e.target.value)}>
                    {['blue', 'teal', 'violet', 'amber', 'coral', 'indigo', 'cyan'].map((color) => <option value={color} key={color}>{color}</option>)}
                  </select>
                  <input aria-label="新项目排序" value={projectOrder} onChange={(e) => setProjectOrder(Number(e.target.value) || 0)} min={0} max={10000} type="number" />
                  <button className="ghost-btn" onClick={() => void createProject()}>添加</button>
                </div>
                {projectMessage && <p className="setting-hint setting-hint-error" role="status">{projectMessage}</p>}
              </div>
            )}

            {isOwner && (
              <div className="setting-row">
                <span className="setting-label">AI 助手（可选）</span>
                <p className="setting-hint">密钥仅提交到服务端并加密保存，绝不会返回浏览器。未配置时计时功能不受影响。</p>
                <select aria-label="AI provider" value={ai.provider} onChange={(e) => setAi((v) => ({ ...v, provider: e.target.value, api_base: e.target.value === 'siliconflow' ? 'https://api.siliconflow.cn/v1' : v.api_base }))}>
                  <option value="siliconflow">SiliconFlow</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </select>
                <input aria-label="AI API Base" value={ai.api_base} onChange={(e) => setAi((v) => ({ ...v, api_base: e.target.value }))} placeholder="API Base" />
                <input aria-label="AI model" value={ai.model} onChange={(e) => setAi((v) => ({ ...v, model: e.target.value }))} placeholder="模型名称" />
                <input aria-label="AI API key" value={ai.api_key} onChange={(e) => setAi((v) => ({ ...v, api_key: e.target.value }))} placeholder="API Key（仅用于保存/更新）" type="password" autoComplete="new-password" />
                <button className="ghost-btn" onClick={() => void saveAi()}>保存 AI 配置</button>
                {aiMessage && <p className="setting-hint" role="status">{aiMessage}</p>}
              </div>
            )}
          </div>

          <div className="setting-row">
            <span className="setting-label">结束提示音</span>
            <div className="seg-control" role="radiogroup" aria-label="结束提示音">
              {[
                ['off', '关闭'],
                ['on', '开启'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={settings.finishSound === (value === 'on')}
                  className={`seg-item ${settings.finishSound === (value === 'on') ? 'active' : ''}`}
                  onClick={() => updateSettings({ finishSound: value === 'on' })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span className="setting-label">环境音（默认关闭）</span>
            <div className="ambient-list" role="radiogroup" aria-label="环境音">
              {(['none', 'rain', 'wind', 'waves', 'fire', 'cafe', 'tick'] as const).map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={settings.ambientKind === k}
                  className={`ambient-item ${settings.ambientKind === k ? 'active' : ''}`}
                  onClick={() => updateSettings({ ambientKind: k })}
                >
                  {k === 'none' ? '关闭' : AMBIENT_LABELS[k]}
                </button>
              ))}
            </div>
            <label className="ambient-volume">
              <span>音量 <output>{Math.round(settings.ambientVolume * 100)}%</output></span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(settings.ambientVolume * 100)}
                onChange={(e) => updateSettings({ ambientVolume: Number(e.target.value) / 100 })}
                aria-label="环境音音量"
              />
            </label>
            <p className="setting-hint">
              全部由浏览器实时合成。新用户默认 45%，实际响度仍取决于系统、浏览器和耳机音量；建议先低后高调整。刷新后需点击页面恢复声音（浏览器自动播放限制）。
            </p>
          </div>

          <div className="setting-row">
            <span className="setting-label">动画</span>
            <div className="seg-control" role="radiogroup" aria-label="动画">
              {[
                ['on', '开'],
                ['off', '关'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={animationsOn === (value === 'on')}
                  className={`seg-item ${animationsOn === (value === 'on') ? 'active' : ''}`}
                  disabled={reduced}
                  onClick={() => setAnimationsEnabled(value === 'on')}
                >
                  {label}
                </button>
              ))}
            </div>
            {reduced && <p className="setting-hint">系统开启了「减弱动态效果」，动画已自动关闭。</p>}
          </div>

          <div className="setting-row">
            <span className="setting-label">全屏</span>
            <div>
              <button
                className="ghost-btn"
                data-testid="settings-fullscreen-btn"
                onClick={() => void enterFullscreen()}
              >
                <Maximize size={15} aria-hidden /> 进入全屏
              </button>
            </div>
            {fullscreenError && <p className="setting-hint setting-hint-error" role="status">{fullscreenError}</p>}
            <p className="setting-hint">外部进入全屏（F11 或系统手势）同样会被自动识别。设备角色：{deviceRole === 'secondary' ? '副屏（Pad）' : '主控（电脑）'}，识别不对可用 ?role=secondary / ?role=main 覆盖。</p>
          </div>

          <div className="setting-row">
            <span className="setting-label">说明</span>
            <p className="setting-hint">
              计时结束只表示这段时间已记录；请在你自己的项目工具中跟进任务成果。
            </p>
          </div>

          {isOwner && (
            <div className="setting-row">
              <button className="danger-btn" onClick={() => void onLogout()}>
                退出登录
              </button>
            </div>
          )}

          <Dialog.Close className="icon-btn dialog-close" aria-label="关闭">
            <X size={16} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
