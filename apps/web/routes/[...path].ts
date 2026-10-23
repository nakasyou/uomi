import { defineHandler } from 'void'
import app from '../worker/app'
const handle = defineHandler((c) => app.fetch(c.req.raw, c.env, c.executionCtx))
export const GET = handle
export const POST = handle
export const PUT = handle
export const DELETE = handle
export const PATCH = handle
