import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { it } from "node:test"

it("refreshes OAuth from a compiled CLI host using a JavaScript runtime", () => {
  const preload = `
    globalThis.fetch = async (_url, options) => {
      const body = new URLSearchParams(options.body);
      if (body.get('refresh_token') !== 'test-refresh') throw new Error('Missing stdin token');
      return { ok: true, json: async () => ({ access_token: 'test-access', expires_in: 3600 }) };
    };
  `
  const script = `
    const { refreshViaOAuth } = await import(${JSON.stringify(new URL("./credentials.ts", import.meta.url).href)});
    Object.defineProperty(process, 'execPath', { value: '/nonexistent/opencode2' });
    process.stdout.write(JSON.stringify(refreshViaOAuth('test-refresh')));
  `
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
        CLAUDE_AUTH_DEBUG: "",
      },
    },
  )
  const credentials = JSON.parse(output)
  assert.ok(
    credentials,
    "OAuth refresh must not execute the compiled CLI as Node",
  )
  assert.equal(credentials.accessToken, "test-access")
  assert.equal(credentials.refreshToken, "test-refresh")
  assert.ok(credentials.expiresAt > Date.now())
})
