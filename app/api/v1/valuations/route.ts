import { handler } from '@/lib/api'
import { addValuation, valuationSchema } from '@/lib/ops'

export const POST = handler(valuationSchema, addValuation)
