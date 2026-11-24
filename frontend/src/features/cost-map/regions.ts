import type { GeometryCollection, Topology } from 'topojson-specification'

export type WorldGeography = Topology<{ countries: GeometryCollection }>

export interface RegionExpense {
  region: string
  cloud_type: string
  total_cost: number
  resource_count: number
  pct: number
  coordinates: { lat: number; lon: number }
  label: string
}

export function regionKey(entry: RegionExpense) {
  return `${entry.cloud_type}/${entry.region}`
}

export function hasMapLocation({ coordinates, label }: RegionExpense) {
  // The billing API uses "Unknown" at (0, 0) for regions it cannot locate.
  return coordinates && Number.isFinite(coordinates.lat) && Math.abs(coordinates.lat) <= 90
    && Number.isFinite(coordinates.lon) && Math.abs(coordinates.lon) <= 180
    && !(label === 'Unknown' && coordinates.lat === 0 && coordinates.lon === 0)
}
