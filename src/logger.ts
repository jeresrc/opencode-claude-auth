import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Writable } from "node:stream"

const JWT_PATTERN =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g
const ACCESSOR_MARKER = "[Accessor]"
const CIRCULAR_MARKER = "[Circular]"
const UNSERIALIZABLE_MARKER = "[Unserializable]"

type LogMode = "disabled" | "file" | "stream"
type LoggerFileOps = {
  appendFileSync: typeof appendFileSync
  existsSync: typeof existsSync
  mkdirSync: typeof mkdirSync
  writeFileSync: typeof writeFileSync
}

let mode: LogMode = "disabled"
let logFilePath: string | null = null
let logStream: Writable | null = null
const defaultFileOps: LoggerFileOps = {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
}
let fileOps: LoggerFileOps = defaultFileOps

const REDACTED = "REDACTED"
const SENSITIVE_KEY_NAMES = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "xapikey",
  "authorization",
  "credential",
  "credentials",
  "password",
  "secret",
])

function getDefaultLogPath(): string {
  return join(homedir(), ".local", "share", "opencode", "claude-auth-debug.log")
}

export function initLogger(options?: {
  stream?: Writable
  files?: Partial<LoggerFileOps>
}): void {
  closeLogger()
  fileOps = { ...defaultFileOps, ...options?.files }

  if (options?.stream) {
    mode = "stream"
    logStream = options.stream
    return
  }

  const envVal = process.env.CLAUDE_AUTH_DEBUG
  if (!envVal) {
    mode = "disabled"
    return
  }

  mode = "file"
  logFilePath = envVal === "1" ? getDefaultLogPath() : envVal

  const dir = dirname(logFilePath)
  try {
    if (!fileOps.existsSync(dir)) {
      fileOps.mkdirSync(dir, { recursive: true })
    }
  } catch {
    // Debug logging is best-effort and must never affect auth/request flow.
  }
  try {
    fileOps.writeFileSync(logFilePath, "", "utf-8")
  } catch {
    // Debug logging is best-effort and must never affect auth/request flow.
  }
}

export function log(event: string, data?: Record<string, unknown>): void {
  if (mode === "disabled") return

  const redactedData = safeRedact(data ?? {})
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...redactedData,
  }
  const line = safeStringifyLogEntry(entry)

  try {
    if (mode === "file" && logFilePath) {
      fileOps.appendFileSync(logFilePath, line, "utf-8")
    } else if (mode === "stream" && logStream) {
      logStream.write(line)
    }
  } catch {
    // Debug logging is best-effort and must never affect auth/request flow.
  }
}

export function closeLogger(): void {
  mode = "disabled"
  logFilePath = null
  logStream = null
  fileOps = defaultFileOps
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "")
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(normalizeKey(key))
}

function redactString(key: string, value: string): string {
  if (key && isSensitiveKey(key)) return REDACTED

  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(JWT_PATTERN, "JWT_REDACTED")
    .replace(/\baccess_token=([^&\s"'{};,]+)/gi, `access_token=${REDACTED}`)
    .replace(/\brefresh_token=([^&\s"'{};,]+)/gi, `refresh_token=${REDACTED}`)
    .replace(/("access_token"\s*:\s*")[^"]+(")/gi, `$1${REDACTED}$2`)
    .replace(/("refresh_token"\s*:\s*")[^"]+(")/gi, `$1${REDACTED}$2`)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-REDACTED")
}

function defineDataProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function safeErrorString(
  value: Error,
  key: "name" | "message" | "stack",
): string | undefined {
  try {
    const property = value[key]
    if (typeof property !== "string") return undefined
    return redactString(key, property)
  } catch {
    return UNSERIALIZABLE_MARKER
  }
}

function redactError(value: Error): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const name = safeErrorString(value, "name")
  const message = safeErrorString(value, "message")
  const stack = safeErrorString(value, "stack")

  if (name !== undefined) {
    defineDataProperty(result, "name", name)
  }
  if (message !== undefined) {
    defineDataProperty(result, "message", message)
  }
  if (stack !== undefined) {
    defineDataProperty(result, "stack", stack)
  }
  return result
}

function tryRedactDate(key: string, value: Date): unknown {
  try {
    if (Number.isNaN(Date.prototype.getTime.call(value)))
      return "[Invalid Date]"
    return redactString(key, Date.prototype.toISOString.call(value))
  } catch {
    return UNSERIALIZABLE_MARKER
  }
}

function tryRedactUrl(key: string, value: URL): unknown {
  try {
    const href = Object.getOwnPropertyDescriptor(
      URL.prototype,
      "href",
    )?.get?.call(value)
    if (typeof href !== "string") return UNSERIALIZABLE_MARKER
    return redactString(key, href)
  } catch {
    return UNSERIALIZABLE_MARKER
  }
}

function tryGetDescriptors(value: object): PropertyDescriptorMap | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value)
  } catch {
    return undefined
  }
}

function redactArray(
  value: unknown[],
  seen: WeakSet<object>,
): unknown[] | string {
  let length: number
  try {
    length = value.length
  } catch {
    return UNSERIALIZABLE_MARKER
  }

  const descriptors = tryGetDescriptors(value)
  if (!descriptors) return UNSERIALIZABLE_MARKER

  seen.add(value)
  try {
    const result = Array.from<unknown>({ length })
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor) continue
      result[index] =
        "value" in descriptor
          ? redactValue("", descriptor.value, seen)
          : ACCESSOR_MARKER
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function redactObject(
  value: object,
  seen: WeakSet<object>,
): Record<string, unknown> | string {
  const descriptors = tryGetDescriptors(value)
  if (!descriptors) return UNSERIALIZABLE_MARKER

  seen.add(value)
  try {
    const result: Record<string, unknown> = {}
    for (const [childKey, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue

      const redactedKey = redactString("", childKey)
      const childValue = isSensitiveKey(childKey)
        ? REDACTED
        : "value" in descriptor
          ? redactValue(childKey, descriptor.value, seen)
          : ACCESSOR_MARKER
      defineDataProperty(result, redactedKey, childValue)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function redactValue(
  key: string,
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (key && isSensitiveKey(key)) return REDACTED
  if (typeof value === "string") return redactString(key, value)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "symbol") return "[Symbol]"
  if (typeof value === "function") return "[Function]"
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return CIRCULAR_MARKER

  try {
    if (value instanceof Date) return tryRedactDate(key, value)
    if (value instanceof URL) return tryRedactUrl(key, value)
    if (value instanceof Error) {
      seen.add(value)
      const result = redactError(value)
      seen.delete(value)
      return result
    }
  } catch {
    return UNSERIALIZABLE_MARKER
  }

  try {
    if (Array.isArray(value)) return redactArray(value, seen)
  } catch {
    return UNSERIALIZABLE_MARKER
  }

  return redactObject(value, seen)
}

export function redact(data: Record<string, unknown>): Record<string, unknown> {
  const result = redactValue("", data, new WeakSet<object>())
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>
  }
  return { payload: result }
}

function safeRedact(data: Record<string, unknown>): Record<string, unknown> {
  try {
    return redact(data)
  } catch {
    return { payload: UNSERIALIZABLE_MARKER }
  }
}

function safeStringifyLogEntry(entry: Record<string, unknown>): string {
  try {
    return `${JSON.stringify(entry)}\n`
  } catch {
    return `${JSON.stringify({
      ts: entry.ts,
      event: entry.event,
      payload: UNSERIALIZABLE_MARKER,
    })}\n`
  }
}
