import { Layers3 } from 'lucide-react'

export default function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Layers3 size={21} strokeWidth={1.8} />
      </span>
      <div>
        <span className={`brand-name ${inverse ? 'text-white' : ''}`}>
          CloudAtlas
        </span>
        <p className={`brand-caption ${inverse ? 'text-white/70' : ''}`}>
          Cloud intelligence
        </p>
      </div>
    </div>
  )
}
