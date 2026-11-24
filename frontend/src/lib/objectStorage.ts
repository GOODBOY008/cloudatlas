import i18n from '../i18n'
import { providerLabel } from './providers'

// Display names only. Billing keys, identifiers, drill-down filters and bucket names
// retain the exact values supplied by the provider.
const serviceProviders = new Map<string, string>([
  ['s3', 'aws'], ['amazon s3', 'aws'], ['aws s3', 'aws'], ['amazon simple storage service', 'aws'],
  ['oss', 'alibaba'], ['aliyun oss', 'alibaba'], ['alibaba cloud oss', 'alibaba'], ['对象存储 oss', 'alibaba'],
])

export function cloudServiceLabel(value: string | null | undefined): string {
  if (!value) return '—'
  const key = value.trim().toLowerCase()
  const provider = serviceProviders.get(key)
  if (provider) return `${i18n.t('nav.objectStorage')} · ${providerLabel(provider)}`
  if (key === 'object storage' || key === '对象存储') return i18n.t('nav.objectStorage')
  return value
}

// Old engine-generated recommendations can still be active or archived. Translate
// only known engine text; a resource name may legitimately contain "S3" or "OSS".
const recommendationText = new Map<string, { titles: string[]; descriptions: string[] }>([
  ['abandoned_s3_bucket', {
    titles: ['Abandoned S3 Bucket', 'Idle object storage bucket'],
    descriptions: ['S3 bucket has minimal activity — consider archiving or deleting', 'Object storage bucket has minimal activity — consider archiving or deleting'],
  }],
  ['s3_intelligent_tiering', {
    titles: ['Enable S3 Intelligent-Tiering', 'Enable automatic object storage tiering'],
    descriptions: ['Enable Intelligent-Tiering to automatically move data to lower-cost tiers', 'Enable automatic tiering to move infrequently accessed objects to lower-cost tiers'],
  }],
  ['s3_public_bucket', {
    titles: ['Public S3 Bucket', 'Public object storage bucket'],
    descriptions: ['Bucket policy or ACL allows public access'],
  }],
])

export function storageRecommendationType(type: string) {
  return recommendationText.has(type) ? i18n.t(`recType.${type}`) : type
}

export function recommendationTitle(rec: { rec_type: string; title: string }) {
  const prefix = recommendationText.get(rec.rec_type)?.titles.find(text => rec.title.startsWith(text + ': '))
  return prefix ? `${storageRecommendationType(rec.rec_type)} · ${rec.title.slice(prefix.length + 2)}` : rec.title
}

export function recommendationDescription(rec: { rec_type: string; description?: string | null }) {
  const original = rec.description
  if (!original || !recommendationText.get(rec.rec_type)?.descriptions.includes(original)) return original
  return i18n.t(`objectStorage.recommendation.${rec.rec_type}`)
}
