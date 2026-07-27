import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Writable } from "node:stream"

const JWT_PATTERN =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g

type LogMode = "disabled" | "file" | "stream"

let mode: LogMode = "disabled"
let logFilePath: string | null = null
let logStream: Writable | null = null

function getDefaultLogPath(): string {
  return join(homedir(), ".local", "share", "opencode", "claude-auth-debug.log")
}

export function initLogger(options?: { stream?: Writable }): void {
  closeLogger()

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
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(logFilePath, "", "utf-8")
}

export function log(event: string, data?: Record<string, unknown>): void {
  if (mode === "disabled") return

  const entry = {
    ts: new Date().toISOString(),
    event,
    ...redact(data ?? {}),
  }
  const line = JSON.stringify(entry) + "\n"

  if (mode === "file" && logFilePath) {
    appendFileSync(logFilePath, line, "utf-8")
  } else if (mode === "stream" && logStream) {
    logStream.write(line)
  }
}

export function closeLogger(): void {
  mode = "disabled"
  logFilePath = null
  logStream = null
}

function redactString(key: string, value: string): string {
  const normalizedKey = key.toLowerCase()

  if (
    normalizedKey === "refreshtoken" ||
    normalizedKey === "refresh_token" ||
    normalizedKey === "access_token" ||
    normalizedKey === "x-api-key"
  ) {
    return "REDACTED"
  }

  if (normalizedKey === "accesstoken") {
    const prefix = value.slice(0, 8)
    return `${prefix}...REDACTED`
  }

  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer REDACTED")
    .replace(JWT_PATTERN, "JWT_REDACTED")
    .replace(/\baccess_token=([^&\s"'{};,]+)/gi, "access_token=REDACTED")
    .replace(/\brefresh_token=([^&\s"'{};,]+)/gi, "refresh_token=REDACTED")
    .replace(/("access_token"\s*:\s*")[^"]+(")/gi, "$1REDACTED$2")
    .replace(/("refresh_token"\s*:\s*")[^"]+(")/gi, "$1REDACTED$2")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-REDACTED")
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function redactError(value: Error): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: redactString("name", value.name),
    message: redactString("message", value.message),
  }
  if (typeof value.stack === "string") {
    result.stack = redactString("stack", value.stack)
  }
  return result
}

function redactValue(
  key: string,
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactString(key, value)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"

  if (value instanceof Error) {
    seen.add(value)
    const result = redactError(value)
    seen.delete(value)
    return result
  }

  if (Array.isArray(value)) {
    seen.add(value)
    const result = value.map((item) => redactValue("", item, seen))
    seen.delete(value)
    return result
  }

  if (!isPlainObject(value)) return value

  seen.add(value)
  const result: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactValue(childKey, childValue, seen)
  }
  seen.delete(value)
  return result
}

export function redact(data: Record<string, unknown>): Record<string, unknown> {
  return redactValue("", data, new WeakSet<object>()) as Record<string, unknown>
}
