/** iOS 锁屏式 PIN 界面：六位圆点 + 数字键盘。setup 需要输入两次确认。 */

import { useEffect, useState } from 'react';
import { Delete, Lock } from 'lucide-react';

interface Props {
  phase: 'setup' | 'login';
  onSetup: (p: string) => Promise<boolean>;
  onLogin: (p: string) => Promise<boolean>;
  error: string | null;
}

const KEYS: Array<string | 'del' | 'empty'> = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'empty', '0', 'del'];

export default function AuthGate({ phase, onSetup, onLogin, error }: Props) {
  const [entry, setEntry] = useState('');
  const [firstPass, setFirstPass] = useState<string | null>(null); // setup 第一次输入
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (pin: string) => {
    setBusy(true);
    const ok = phase === 'setup' ? await onSetup(pin) : await onLogin(pin);
    setBusy(false);
    if (!ok) {
      setLocalError(phase === 'login' ? 'PIN 不正确' : '设置失败，请重试');
      setEntry('');
      if (phase === 'setup') setFirstPass(null);
      triggerShake();
    }
  };

  const triggerShake = () => {
    setShake(true);
    window.setTimeout(() => setShake(false), 450);
  };

  const press = (k: string | 'del' | 'empty') => {
    if (busy || k === 'empty') return;
    if (k === 'del') {
      setEntry((e) => e.slice(0, -1));
      return;
    }
    setEntry((e) => {
      if (e.length >= 6) return e;
      const next = e + k;
      if (next.length === 6) {
        // 满六位：延迟一拍给圆点动画完成
        window.setTimeout(() => handleComplete(next), 180);
      }
      return next;
    });
  };

  const handleComplete = async (pin: string) => {
    if (phase === 'setup') {
      if (firstPass === null) {
        setFirstPass(pin);
        setEntry('');
        setLocalError(null);
      } else if (firstPass === pin) {
        await submit(pin);
      } else {
        setLocalError('两次输入不一致，请重新开始');
        setFirstPass(null);
        setEntry('');
        triggerShake();
      }
    } else {
      await submit(pin);
    }
  };

  // 物理键盘支持：数字键输入、退格删除、回车提交
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, firstPass, phase]);

  const title =
    phase === 'setup'
      ? firstPass === null
        ? '设置 6 位数字 PIN'
        : '再输入一次以确认'
      : '输入 PIN 解锁';

  return (
    <div className="auth-gate">
      <div className="auth-card pin-card">
        <div className="auth-icon">
          <Lock size={20} />
        </div>
        <h1 className="auth-title">{title}</h1>
        <p className="auth-hint">
          {phase === 'setup'
            ? firstPass === null
              ? '选一个你记得住的 6 位数字'
              : '和刚才一样的 6 位数字'
            : '欢迎回来'}
        </p>

        <div className={`pin-dots ${shake ? 'shake' : ''}`} role="status" aria-label={`已输入 ${entry.length} 位`}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={`pin-dot ${i < entry.length ? 'filled' : ''}`} />
          ))}
        </div>

        {(localError || error) && <p className="auth-error">{localError ?? error}</p>}

        <div className="pin-pad">
          {KEYS.map((k, i) =>
            k === 'empty' ? (
              <span key={i} className="pin-key placeholder" aria-hidden />
            ) : k === 'del' ? (
              <button
                key={i}
                type="button"
                className="pin-key icon-key"
                onClick={() => press('del')}
                aria-label="删除一位"
                disabled={busy || entry.length === 0}
              >
                <Delete size={22} />
              </button>
            ) : (
              <button key={i} type="button" className="pin-key" onClick={() => press(k)} disabled={busy} aria-label={`数字 ${k}`}>
                {k}
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
