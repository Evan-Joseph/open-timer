import { useState } from 'react';
import { Lock } from 'lucide-react';

interface Props {
  phase: 'setup' | 'login';
  onSetup: (p: string) => Promise<boolean>;
  onLogin: (p: string) => Promise<boolean>;
  error: string | null;
}

export default function AuthGate({ phase, onSetup, onLogin, error }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (phase === 'setup' && password.length < 12) {
      setLocalError('密码至少 12 位');
      return;
    }
    setBusy(true);
    const ok = phase === 'setup' ? await onSetup(password) : await onLogin(password);
    setBusy(false);
    if (!ok) setLocalError(phase === 'login' ? '密码不正确' : '设置失败');
  };

  return (
    <div className="auth-gate">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="auth-icon">
          <Lock size={20} />
        </div>
        <h1 className="auth-title">{phase === 'setup' ? '设置时钟密码' : '解锁沉浸时钟'}</h1>
        <p className="auth-hint">
          {phase === 'setup' ? '这是你的唯一登录密码，至少 12 位。设置后保存在安全的地方。' : '输入密码继续计时。'}
        </p>
        <input
          type="password"
          className="auth-input"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          placeholder={phase === 'setup' ? '至少 12 位' : '密码'}
          aria-label="密码"
        />
        {(localError || error) && <p className="auth-error">{localError ?? error}</p>}
        <button type="submit" className="primary-btn" disabled={busy}>
          {busy ? '请稍候…' : phase === 'setup' ? '设置并进入' : '进入'}
        </button>
      </form>
    </div>
  );
}
