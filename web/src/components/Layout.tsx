import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';

const NAV: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/transactions', label: 'Transactions', icon: 'list' },
  { to: '/receipts', label: 'Receipts', icon: 'receipt' },
  { to: '/import', label: 'Import', icon: 'upload' },
  { to: '/rules', label: 'Categories & rules', icon: 'tag' },
];

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('ledgerlens.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable: fall through to the OS preference */
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function Layout() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    try {
      localStorage.setItem('ledgerlens.theme', theme);
    } catch {
      /* not persisted; the choice still applies for this visit */
    }
  }, [theme]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="LedgerLens home">
          <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#1d3558" />
            <circle cx="14" cy="14" r="7" fill="none" stroke="#6da7ec" strokeWidth="2.5" />
            <path d="M19.5 19.5 25 25" stroke="#e34948" strokeWidth="3" strokeLinecap="round" />
            <path d="M10.5 15.5 13 13l2 2 2.5-3" fill="none" stroke="#fcfcfb" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="brand-name">LedgerLens</span>
        </NavLink>

        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} title={item.label}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="privacy-note">
            <Icon name="lock" size={15} />
            <span>Your data stays in a database on this computer.</span>
          </div>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
