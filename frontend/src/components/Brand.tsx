import { Layers3 } from 'lucide-react'

export default function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className="brand">
      <span
        className={`brand-mark ${inverse ? '!bg-[#b4e8d4] !text-[#102d2c]' : ''}`}
      >
        <Layers3 size={21} strokeWidth={1.8} />
      </span>
      <div>
        <span className={`brand-name ${inverse ? 'text-white' : ''}`}>
          CloudAtlas<span className="text-accent">.</span>
        </span>
        <p className={`brand-caption ${inverse ? '!text-[#9dbbb6]' : ''}`}>
          Cloud intelligence
        </p>
      </div>
    </div>
  )
}
