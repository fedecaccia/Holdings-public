import { handler } from '@/lib/api'
import { addCashFlow, cashFlowSchema } from '@/lib/ops'

export const POST = handler(cashFlowSchema, addCashFlow)
