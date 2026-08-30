import type {
  TransitPlanRequest,
  TransitPlanResponse,
  TransitProvidersResponse,
} from '@trek/shared'
import { apiClient } from './client'

export const transitApi = {
  geocode: (q: string, opts?: { lang?: string; near?: string }) =>
    apiClient.get('/transit/geocode', { params: { q, lang: opts?.lang, near: opts?.near } }).then(r => r.data),
  providers: () =>
    apiClient.get('/transit/providers').then(r => r.data as TransitProvidersResponse),
  plan: (params: TransitPlanRequest) =>
    apiClient.get('/transit/plan', { params }).then(r => r.data as TransitPlanResponse),
}
