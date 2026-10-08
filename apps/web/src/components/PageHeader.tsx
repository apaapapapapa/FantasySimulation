import type { ReactNode } from 'react';

/** Decorative vector artwork: no external fonts, images or network requests. */
function ArenaEmblem() {
  return (
    <svg className="arena-emblem" viewBox="0 0 480 360" fill="none" aria-hidden="true">
      <g stroke="currentColor">
        <ellipse cx="240" cy="286" rx="183" ry="37" opacity=".18" />
        <ellipse cx="240" cy="286" rx="146" ry="27" opacity=".25" />
        <circle cx="240" cy="162" r="128" opacity=".18" />
        <circle cx="240" cy="162" r="111" strokeDasharray="1 12" opacity=".5" />
        <path d="M240 18v28m0 232v28M96 162h28m232 0h28" opacity=".6" />
        <path d="m240 38 108 124-108 124-108-124Z" opacity=".22" />
        <path d="m163 65 89 150-13 16L143 86Z" fill="currentColor" fillOpacity=".09" />
        <path d="m317 65-89 150 13 16L337 86Z" fill="currentColor" fillOpacity=".14" />
        <path d="m150 77 94 146m86-146-94 146M214 216l48-29m-4 29-48-29" strokeWidth="3" />
        <path d="m242 224 20 35m-24-35-20 35" strokeWidth="7" />
        <circle cx="267" cy="267" r="6" fill="currentColor" />
        <circle cx="213" cy="267" r="6" fill="currentColor" />
        <path
          d="m240 77 5 12-5 12-5-12Zm-88 79 4 8-4 8-4-8Zm176 0 4 8-4 8-4-8Z"
          fill="currentColor"
        />
      </g>
      <text x="240" y="337" textAnchor="middle" fill="currentColor" fontSize="9" letterSpacing="7">
        THE ART OF BATTLE
      </text>
    </svg>
  );
}

export function PageHeader({
  title,
  eyebrow,
  description,
  mode,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  mode: 'public' | 'local';
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="topbar">
        <a className="brand" href={mode === 'public' ? '#/' : '#app-top'}>
          <span className="brand-icon" aria-hidden="true">
            ✦
          </span>
          <span>
            FANTASY<span className="brand-subtitle">SIMULATION</span>
          </span>
        </a>
        <span className="edition-label">
          {mode === 'public' ? 'BATTLE ARCHIVE' : 'CREATOR STUDIO'}
        </span>
        <span className="badge">{mode === 'public' ? '観戦ライブラリ' : 'ローカル編集'}</span>
      </div>
      <div className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="intro">{description}</p>
          <div className="hero-rule" aria-hidden="true">
            <span>01</span>
            <i />
            <span>FANTASY / STRATEGY / DUEL</span>
          </div>
        </div>
        <ArenaEmblem />
      </div>
      {children}
    </header>
  );
}

export function PageFooter() {
  return (
    <footer>
      <span>FANTASY SIMULATION</span>
      <span>一戦ごとに、戦略の先へ。</span>
    </footer>
  );
}
