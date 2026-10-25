import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CliError } from './errors.ts'

export const DEFAULT_BASE_URL = 'https://uomi-transcript-search.nakasyou.chatgpt.site'

export interface Config {
  baseUrl: string
  apiKey: string
  sitesToken?: string
}

export interface ConfigOptions {
  env?: Record<string, string | undefined>
  envFile?: string
}

function configFile(home = process.env.HOME || homedir()): string {
  return join(home, '.config', 'uomi', 'env')
}

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const separator = line.indexOf('=')
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2 && value[0] === value[value.length - 1] && /["']/.test(value[0]))
      value = value.slice(1, -1)
    if (key) values[key] = value
  }
  return values
}

function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new CliError(`cannot read ${path}: ${(error as Error).message}`)
  }
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CliError('UOMI_BASE_URL must be an absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new CliError('UOMI_BASE_URL must use http or https')
  return raw
}

export function loadConfig(options: ConfigOptions = {}): Config {
  const env = options.env ?? process.env
  const envFile = options.envFile ?? configFile()
  const file =
    env.UOMI_BASE_URL && env.UOMI_API_KEY && env.UOMI_SITES_TOKEN ? {} : readEnvFile(envFile)
  const value = (key: string) => env[key]?.trim() || file[key]?.trim() || ''
  const apiKey = value('UOMI_API_KEY')
  if (!apiKey)
    throw new CliError(
      `missing UOMI_API_KEY; set it in the environment or in ${envFile} (the value is never printed)`,
    )
  return {
    baseUrl: normalizeBaseUrl(value('UOMI_BASE_URL') || DEFAULT_BASE_URL),
    apiKey,
    sitesToken: value('UOMI_SITES_TOKEN') || undefined,
  }
}
