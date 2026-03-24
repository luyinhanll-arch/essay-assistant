export type MascotMood = 'idle' | 'thinking' | 'happy'

interface MascotProps {
  size?: number
  mood?: MascotMood
  className?: string
}

export function Mascot({ size = 40, mood = 'idle', className = '' }: MascotProps) {
  const isHappy    = mood === 'happy'
  const isThinking = mood === 'thinking'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 105"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <radialGradient id="faceGrad" cx="42%" cy="32%" r="62%">
          <stop offset="0%"   stopColor="#4C2214" />
          <stop offset="100%" stopColor="#1E0A04" />
        </radialGradient>
      </defs>

      {/* ── Ears (drawn behind face) ── */}
      <circle cx="26" cy="24" r="19" fill="#130802" />
      <circle cx="74" cy="24" r="19" fill="#130802" />
      <circle cx="26" cy="24" r="13" fill="#3C1A0A" />
      <circle cx="74" cy="24" r="13" fill="#3C1A0A" />
      <circle cx="26" cy="24" r="7"  fill="#C8B8A0" opacity="0.38" />
      <circle cx="74" cy="24" r="7"  fill="#C8B8A0" opacity="0.38" />

      {/* ── Face (circle — soft and round) ── */}
      <circle cx="50" cy="59" r="42" fill="#130802" />
      <circle cx="50" cy="59" r="40" fill="url(#faceGrad)" />

      {/* ── Tear stripe markings ── */}
      <path d="M 28 56 Q 17 68 20 80" stroke="#C8B8A0" strokeWidth="7.5" fill="none" strokeLinecap="round" opacity="0.38" />
      <path d="M 72 56 Q 83 68 80 80" stroke="#C8B8A0" strokeWidth="7.5" fill="none" strokeLinecap="round" opacity="0.38" />

      {/* ── Eyes ── */}
      {isHappy ? (
        <>
          {/* Squinting happy arcs */}
          <path d="M 23 54 Q 35 42 47 54" stroke="#EAD8C4" strokeWidth="4" fill="none" strokeLinecap="round" />
          <path d="M 53 54 Q 65 42 77 54" stroke="#EAD8C4" strokeWidth="4" fill="none" strokeLinecap="round" />
          {/* Rosy cheeks */}
          <circle cx="17" cy="68" r="11" fill="#D4708A" opacity="0.22" />
          <circle cx="83" cy="68" r="11" fill="#D4708A" opacity="0.22" />
        </>
      ) : isThinking ? (
        <>
          {/* Sclera */}
          <circle cx="35" cy="53" r="11" fill="#EAD8C4" />
          <circle cx="65" cy="53" r="11" fill="#EAD8C4" />
          {/* Pupils looking up */}
          <circle cx="35" cy="50" r="7"  fill="#1C0802" />
          <circle cx="65" cy="50" r="7"  fill="#1C0802" />
          <circle cx="38" cy="47" r="2.8" fill="white" opacity="0.85" />
          <circle cx="68" cy="47" r="2.8" fill="white" opacity="0.85" />
          {/* Half-lid overlay */}
          <ellipse cx="35" cy="46" rx="11" ry="6.5" fill="url(#faceGrad)" />
          <ellipse cx="65" cy="46" rx="11" ry="6.5" fill="url(#faceGrad)" />
          {/* Furrowed brows */}
          <path d="M 24 39 Q 35 33 46 38" stroke="#7A5038" strokeWidth="2.8" fill="none" strokeLinecap="round" />
          <path d="M 54 38 Q 65 32 76 38" stroke="#7A5038" strokeWidth="2.8" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          {/* Sclera — big and cute */}
          <circle cx="35" cy="53" r="11" fill="#EAD8C4" />
          <circle cx="65" cy="53" r="11" fill="#EAD8C4" />
          {/* Pupils */}
          <circle cx="36" cy="54" r="7"   fill="#1C0802" />
          <circle cx="66" cy="54" r="7"   fill="#1C0802" />
          {/* Main sparkle highlights */}
          <circle cx="40" cy="50" r="3.5" fill="white" opacity="0.92" />
          <circle cx="70" cy="50" r="3.5" fill="white" opacity="0.92" />
          {/* Secondary highlights */}
          <circle cx="34" cy="57" r="1.8" fill="white" opacity="0.38" />
          <circle cx="64" cy="57" r="1.8" fill="white" opacity="0.38" />
          {/* Rosy cheeks */}
          <circle cx="17" cy="68" r="11" fill="#D4708A" opacity="0.17" />
          <circle cx="83" cy="68" r="11" fill="#D4708A" opacity="0.17" />
        </>
      )}

      {/* ── Nose — small button ── */}
      <ellipse cx="50" cy="67" rx="5"  ry="3.8" fill="#130802" />
      <circle  cx="48" cy="66" r="1.8" fill="white" opacity="0.28" />

      {/* ── Mouth ── */}
      {isHappy ? (
        <path d="M 36 74 Q 50 87 64 74" stroke="#EAD8C4" strokeWidth="2.8" fill="none" strokeLinecap="round" />
      ) : isThinking ? (
        <path d="M 42 76 Q 50 79 58 76" stroke="#7A5038" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      ) : (
        <path d="M 40 75 Q 50 82 60 75" stroke="#C4A888" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      )}
    </svg>
  )
}
