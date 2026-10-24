import { handler } from '@/lib/api'
import { assetPatchSchema, patchAsset } from '@/lib/ops'

// PATCH /api/v1/assets/<id o key>  {"meta":{"apr_manual":0.12}}
export const PATCH = handler(assetPatchSchema, async (body, request) => {
  const ref = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
  return patchAsset(ref, body)
})
