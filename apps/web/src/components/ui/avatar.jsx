import { cn } from '@/lib/utils';

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase() || '?';
}

// Deterministic background per name so the same person always has the same color.
const PALETTE = ['bg-[#EFEAFD] text-[#3B2A7A]', 'bg-[#E3F2EA] text-[#14532D]', 'bg-[#FDEFE3] text-[#7C2D12]', 'bg-[#E5EEFB] text-[#1E3A8A]', 'bg-[#F7E6EE] text-[#831843]'];

function Avatar({ name, size = 'md', className }) {
  const hash = [...(name ?? '')].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const sizes = { sm: 'size-7 text-xs', md: 'size-9 text-sm', lg: 'size-16 text-xl' };
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', sizes[size], PALETTE[hash % PALETTE.length], className)}>
      {initials(name)}
    </span>
  );
}

export { Avatar, initials };
