declare module 'react-simple-maps' {
  import type { ReactNode, SVGProps, MouseEventHandler } from 'react'

  export interface ComposableMapProps {
    projection?: string
    projectionConfig?: Record<string, unknown>
    style?: React.CSSProperties
    children?: ReactNode
  }
  export function ComposableMap(props: ComposableMapProps): JSX.Element

  export interface ZoomableGroupProps {
    zoom?: number
    center?: [number, number]
    onMoveEnd?: (evt: { coordinates: [number, number]; zoom: number }) => void
    children?: ReactNode
  }
  export function ZoomableGroup(props: ZoomableGroupProps): JSX.Element

  export interface GeographiesProps {
    geography: string | object
    children: (args: { geographies: object[] }) => ReactNode
  }
  export function Geographies(props: GeographiesProps): JSX.Element

  export interface GeographyProps extends SVGProps<SVGPathElement> {
    geography: object
    key?: string
    style?: {
      default?: React.CSSProperties
      hover?: React.CSSProperties
      pressed?: React.CSSProperties
    }
  }
  export function Geography(props: GeographyProps): JSX.Element

  export interface MarkerProps {
    coordinates: [number, number]
    children?: ReactNode
    onMouseEnter?: MouseEventHandler<SVGGElement>
    onMouseLeave?: MouseEventHandler<SVGGElement>
    onClick?: MouseEventHandler<SVGGElement>
  }
  export function Marker(props: MarkerProps): JSX.Element

  export interface AnnotationProps {
    subject: [number, number]
    dx?: number
    dy?: number
    children?: ReactNode
  }
  export function Annotation(props: AnnotationProps): JSX.Element

  export interface GraticuleProps extends SVGProps<SVGPathElement> {
    step?: [number, number]
  }
  export function Graticule(props: GraticuleProps): JSX.Element
}
