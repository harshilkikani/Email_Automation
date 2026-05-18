import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface Toast { id: number; kind: 'success'|'error'|'warn'; title: string; msg?: string }
interface Ctx { push: (kind: Toast['kind'], title: string, msg?: string) => void }

const ToastCtx = createContext<Ctx>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], title: string, msg?: string) => {
    const id = Date.now() + Math.random();
    setList(l => [...l, { id, kind, title, msg }]);
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {list.map(t => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div className="t-ico">{t.kind === 'success' ? '✓' : t.kind === 'error' ? '✕' : '◐'}</div>
            <div className="t-body">
              <div className="t-title">{t.title}</div>
              {t.msg && <div className="t-msg">{t.msg}</div>}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
