/** Small code-native line art; surrounding text carries the actual state. */
export function StateGraphic({ kind = 'search' }: { kind?: 'search' | 'photo' }) {
  return (
    <svg className="wb-state-graphic" viewBox="0 0 80 64" fill="none" aria-hidden="true">
      <rect x="8" y="8" width="56" height="44" rx="6" fill="var(--wb-sage)" />
      {kind === 'search' ? (
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M20 21h23M20 29h14M20 37h10" />
          <circle cx="51" cy="39" r="11" fill="var(--wb-paper)" />
          <path d="m59 47 11 10" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <rect x="17" y="17" width="39" height="28" rx="3" />
          <circle cx="28" cy="26" r="3" />
          <path d="m19 42 11-10 8 7 7-5 9 8M59 17l10 10m0-10L59 27" />
        </g>
      )}
    </svg>
  )
}
