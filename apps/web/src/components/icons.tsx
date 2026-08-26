import type { SVGProps } from 'react';

/**
 * The console's icon set.
 *
 * Hand-drawn rather than a dependency: the set actually used is small and fixed (one per nav
 * destination, one per stat card), and a library pulls in hundreds of icons to get twenty. Every
 * icon shares one stroke width and viewBox so they read as one family regardless of which screen
 * they show up on.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(props: IconProps, children: React.ReactNode) {
  const { size = 18, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconGrid = (p: IconProps) =>
  base(
    p,
    <>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.6" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="1.6" />
    </>,
  );

export const IconActivity = (p: IconProps) =>
  base(p, <path d="M3 12h4l2.2-7 4.4 14L16 9l1.6 3H21" />);

export const IconAlertCircle = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v5" />
      <path d="M12 16.2v.1" />
    </>,
  );

export const IconBarChart = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M4 20V10" />
      <path d="M12 20V4" />
      <path d="M20 20v-7" />
      <path d="M3 20h18" />
    </>,
  );

export const IconMessageCircle = (p: IconProps) =>
  base(
    p,
    <path d="M12 20c4.97 0 9-3.6 9-8s-4.03-8-9-8-9 3.6-9 8c0 1.8.63 3.46 1.7 4.8L3.5 20l3.9-1.3c1.4.6 3 .9 4.6 .9Z" />,
  );

export const IconUsers = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.2 19c.6-3.2 3-5 5.8-5s5.2 1.8 5.8 5" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M15.5 14.2c2.3.3 4 1.9 4.5 4.3" />
    </>,
  );

export const IconBookOpen = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M12 6.2C10.6 5 8.4 4.5 4 4.5v13.8c4.4 0 6.6.5 8 1.7 1.4-1.2 3.6-1.7 8-1.7V4.5c-4.4 0-6.6.5-8 1.7Z" />
      <path d="M12 6.2v13.8" />
    </>,
  );

export const IconZap = (p: IconProps) => base(p, <path d="M12.5 3 5 13.2h5.3L10 21l7.5-10.6h-5.3L12.5 3Z" />);

export const IconLightbulb = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M9 18h6" />
      <path d="M9.5 21h5" />
      <path d="M12 3a6.5 6.5 0 0 0-3.6 11.9c.6.4 1 1.1 1 1.9v.4h5.2v-.4c0-.8.4-1.5 1-1.9A6.5 6.5 0 0 0 12 3Z" />
    </>,
  );

export const IconSparkles = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M12 3.5 13.4 8 18 9.4 13.4 10.8 12 15.3l-1.4-4.5L6.2 9.4 10.6 8 12 3.5Z" />
      <path d="M18.5 15 19.3 17.2 21.5 18 19.3 18.8 18.5 21 17.7 18.8 15.5 18 17.7 17.2 18.5 15Z" />
    </>,
  );

export const IconShieldAlert = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.7-7 8.5-4.1-.8-7-4.2-7-8.5V6l7-2.5Z" />
      <path d="M12 8.5v4.2" />
      <path d="M12 15.8v.1" />
    </>,
  );

export const IconMegaphone = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M3 11v2a2 2 0 0 0 2 2h.6l1 5h2.2l-.8-5H10l8 3.6V6.4L10 10H5a2 2 0 0 0-2 1Z" />
    </>,
  );

export const IconBot = (p: IconProps) =>
  base(
    p,
    <>
      <rect x="4.5" y="9" width="15" height="10" rx="2.4" />
      <path d="M12 9V5.5" />
      <circle cx="12" cy="4" r="1.3" />
      <path d="M8.5 14v1.2" />
      <path d="M15.5 14v1.2" />
    </>,
  );

export const IconSliders = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M4 6h9" />
      <path d="M17 6h3" />
      <circle cx="15" cy="6" r="2" />
      <path d="M4 18h3" />
      <path d="M11 18h9" />
      <circle cx="9" cy="18" r="2" />
      <path d="M4 12h13" />
      <circle cx="19" cy="12" r="2" />
    </>,
  );

export const IconOctagonAlert = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M8 3.5h8L20.5 8v8L16 20.5H8L3.5 16V8Z" />
      <path d="M12 8.2v5" />
      <path d="M12 15.8v.1" />
    </>,
  );

export const IconLogOut = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M10 4H5.6A1.6 1.6 0 0 0 4 5.6v12.8A1.6 1.6 0 0 0 5.6 20H10" />
      <path d="M15.5 16 20 12l-4.5-4" />
      <path d="M20 12H9.5" />
    </>,
  );

export const IconCheckCircle = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.3 12.3 11 15l4.8-5.6" />
    </>,
  );

export const IconClock = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </>,
  );

export const IconSend = (p: IconProps) => base(p, <path d="m4 11 16-7-6.5 16-2.4-7.1L4 11Z M13.6 13l3.8 7" />);

export const IconRadio = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="2.4" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M5.8 5.8a9 9 0 0 0 0 12.4" />
      <path d="M18.2 5.8a9 9 0 0 1 0 12.4" />
    </>,
  );

export const IconChevronDown = (p: IconProps) => base(p, <path d="m6 9 6 6 6-6" />);

export const IconInbox = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M4 12h4.2l1.6 2.6h4.4L15.8 12H20" />
      <path d="M4 12 5.6 5.4A1.6 1.6 0 0 1 7.1 4.2h9.8a1.6 1.6 0 0 1 1.5 1.2L20 12v5.4A1.6 1.6 0 0 1 18.4 19H5.6A1.6 1.6 0 0 1 4 17.4Z" />
    </>,
  );

export const IconUserCircle = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="10" r="2.6" />
      <path d="M6.5 18.2c1-2.3 3-3.4 5.5-3.4s4.5 1.1 5.5 3.4" />
    </>,
  );

export const IconSun = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
    </>,
  );

export const IconMoon = (p: IconProps) => base(p, <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />);

export const IconRefresh = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
      <path d="M20.5 4.5V10H15" />
    </>,
  );

export const IconQrCode = (p: IconProps) =>
  base(
    p,
    <>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.4" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.4" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.4" />
      <path d="M14 14h3v3h-3zM20.5 14v3M17.5 20.5h3M14 20.5h0.5" />
    </>,
  );

export const IconPlug = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M9 3.5v5M15 3.5v5" />
      <path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0Z" />
      <path d="M12 17v3.5" />
    </>,
  );

export const IconSettings = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="2.9" />
      <path d="M19.1 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.8 1.8 0 1 1-3.6 0V20a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9H4A1.8 1.8 0 1 1 4 10h.2a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3H10a1.5 1.5 0 0 0 .9-1.4V4a1.8 1.8 0 1 1 3.6 0v.2a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7V10a1.5 1.5 0 0 0 1.4.9h.2a1.8 1.8 0 1 1 0 3.6H20a1.5 1.5 0 0 0-1.4.9Z" />
    </>,
  );
