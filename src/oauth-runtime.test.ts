import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { it } from "node:test"

it("refreshes OAuth from a compiled CLI host using a JavaScript runtime", () => {
  const preload = `
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://platform.claude.com/v1/oauth/token') throw new Error('Obsolete OAuth endpoint');
      if (options.method !== 'POST') throw new Error('Incorrect OAuth method');
      if (options.headers['Content-Type'] !== 'application/json') throw new Error('OAuth requires JSON');
      const body = JSON.parse(options.body);
      if (body.refresh_token !== 'test-refresh') throw new Error('Missing stdin token');
      if (body.grant_type !== 'refresh_token') throw new Error('Incorrect grant');
      if (body.client_id !== '9d1c250a-e61b-44d9-88ed-5944d1962f5e') throw new Error('Incorrect client');
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
