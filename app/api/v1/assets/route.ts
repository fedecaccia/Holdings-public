import { handler } from '@/lib/api'
import { assetSchema, createAsset } from '@/lib/ops'

export const POST = handler(assetSchema, createAsset)
