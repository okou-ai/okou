export function EmailMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="7" fill="#0A84FF" />
      <rect x="6.5" y="9.25" width="19" height="13.5" rx="2.5" fill="white" />
      <path
        d="M7.9 10.9 16 16.9l8.1-6"
        stroke="#0A84FF"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
