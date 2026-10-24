import { handler } from '@/lib/api'
import { addWallet, walletSchema } from '@/lib/ops'

export const POST = handler(walletSchema, addWallet)
