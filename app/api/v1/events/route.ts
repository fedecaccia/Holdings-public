import { handler } from '@/lib/api'
import { addEvent, eventSchema } from '@/lib/ops'

export const POST = handler(eventSchema, addEvent)
