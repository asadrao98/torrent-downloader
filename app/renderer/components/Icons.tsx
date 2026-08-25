/**
 * Inline SVG icons.
 *
 * Drawn here rather than pulled from an icon package: the set is small, and
 * inlining keeps the renderer free of remote or bundled binary assets, which is
 * also what the Content Security Policy expects.
 */

interface IconProps {
  size?: number
  className?: string
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
}

export const IconAll = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <rect x="2" y="3" width="12" height="3" rx="1" />
    <rect x="2" y="10" width="12" height="3" rx="1" />
  </svg>
)

export const IconDownload = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M8 2v7.5" />
    <path d="M5 7l3 3 3-3" />
    <path d="M2.5 12.5h11" />
  </svg>
)

export const IconUpload = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M8 10.5V3" />
    <path d="M5 6l3-3 3 3" />
    <path d="M2.5 13.5h11" />
  </svg>
)

export const IconCheck = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M3 8.5l3.2 3.2L13 5" />
  </svg>
)

export const IconPause = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M6 3v10" />
    <path d="M10 3v10" />
  </svg>
)

export const IconPlay = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M5 3l8 5-8 5V3z" fill="currentColor" stroke="none" />
  </svg>
)

export const IconWarning = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M8 2.5l5.5 10H2.5L8 2.5z" />
    <path d="M8 6.5v3" />
    <circle cx="8" cy="11.2" r="0.55" fill="currentColor" stroke="none" />
  </svg>
)

export const IconSettings = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
  </svg>
)

export const IconMore = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <circle cx="3.4" cy="8" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12.6" cy="8" r="1.15" fill="currentColor" stroke="none" />
  </svg>
)

export const IconFolder = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M1.8 4.2A1.2 1.2 0 013 3h2.7l1.2 1.5H13a1.2 1.2 0 011.2 1.2v6.1A1.2 1.2 0 0113 13H3a1.2 1.2 0 01-1.2-1.2V4.2z" />
  </svg>
)

export const IconFile = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M9.2 1.8H4.4a1.2 1.2 0 00-1.2 1.2v10a1.2 1.2 0 001.2 1.2h7.2a1.2 1.2 0 001.2-1.2V5.6L9.2 1.8z" />
    <path d="M9.2 1.8v3.8h3.6" />
  </svg>
)

export const IconChevron = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M6 4l4 4-4 4" />
  </svg>
)

export const IconClose = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

export const IconMagnet = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M3.2 3v4.6a4.8 4.8 0 009.6 0V3" />
    <path d="M3.2 7.6h3.2M9.6 7.6h3.2" />
  </svg>
)

export const IconClock = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 4.8V8l2.2 1.6" />
  </svg>
)

export const IconRefresh = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M13.2 7a5.2 5.2 0 10-1.6 4.2" />
    <path d="M13.4 3.2v3.6h-3.6" />
  </svg>
)

export const IconLogs = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="1.4" />
    <path d="M5 6h6M5 8.6h6M5 11h3.4" />
  </svg>
)

export const IconInbox = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M2 9.2L3.8 3.4h8.4L14 9.2v3.2a1.2 1.2 0 01-1.2 1.2H3.2A1.2 1.2 0 012 12.4V9.2z" />
    <path d="M2 9.2h3.4l.8 1.6h3.6l.8-1.6H14" />
  </svg>
)

export const IconStop = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" stroke="none" />
  </svg>
)

export const IconTrash = ({ size = 15, className }: IconProps) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M2.8 4.4h10.4" />
    <path d="M6.4 4.4V3.2a1 1 0 011-1h1.2a1 1 0 011 1v1.2" />
    <path d="M4.2 4.4l.6 8a1.2 1.2 0 001.2 1.1h4a1.2 1.2 0 001.2-1.1l.6-8" />
  </svg>
)
