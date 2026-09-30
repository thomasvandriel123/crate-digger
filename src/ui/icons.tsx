/** Small inline icons (stroke, currentColor). Decorative: callers provide accessible names. */

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.8,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
  'aria-hidden': true,
  focusable: 'false',
};

export const SpeakerOn = () => (
  <svg {...base}>
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 6a8.5 8.5 0 0 1 0 12" />
  </svg>
);

export const SpeakerOff = () => (
  <svg {...base}>
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M17 9l5 6M22 9l-5 6" />
  </svg>
);

export const Close = () => (
  <svg {...base} width="14" height="14">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const Flip = () => (
  <svg {...base} width="16" height="16">
    <path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" />
    <path d="M18 3v4h-4M6 21v-4h4" />
  </svg>
);

export const Play = () => (
  <svg {...base} width="16" height="16">
    <path d="M7 5l12 7-12 7V5z" fill="currentColor" />
  </svg>
);

export const Pause = () => (
  <svg {...base} width="16" height="16">
    <path d="M8 5v14M16 5v14" />
  </svg>
);

export const Eject = () => (
  <svg {...base} width="16" height="16">
    <path d="M5 15l7-9 7 9H5zM5 19h14" />
  </svg>
);

export const Back = () => (
  <svg {...base} width="16" height="16">
    <path d="M12 19V5M5 12l7 7 7-7" />
  </svg>
);

export const Dice = () => (
  <svg {...base} width="15" height="15">
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <circle cx="9" cy="9" r="1" fill="currentColor" />
    <circle cx="15" cy="15" r="1" fill="currentColor" />
    <circle cx="15" cy="9" r="1" fill="currentColor" />
    <circle cx="9" cy="15" r="1" fill="currentColor" />
  </svg>
);

export const ArrowUpDown = ({ dir }: { dir: 'asc' | 'desc' }) => (
  <svg {...base} width="14" height="14">
    {dir === 'asc' ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}
  </svg>
);

export const Sliders = () => (
  <svg {...base} width="16" height="16">
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
);

export const Chevron = () => (
  <svg {...base} width="12" height="12">
    <path d="M9 6l6 6-6 6" />
  </svg>
);
