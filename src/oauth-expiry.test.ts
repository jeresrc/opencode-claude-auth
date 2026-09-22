import assert from "node:assert/strict"
import { it } from "node:test"
import { parseOAuthResponse } from "./credentials.ts"

it("honors future absolute OAuth expiry from upstream without accepting seconds or invalid metadata", () => {
  const now = 1790000000000
  const parse = (expires_at: number) =>
    parseOAuthResponse(
      JSON.stringify({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
        expires_at,
      }),
      "old-refresh",
      now,
    )
  assert.equal(parse(now + 1234567.8)?.expiresAt, now + 1234567)
  assert.equal(parse(now / 1000)?.expiresAt, now + 3600000)
  assert.equal(parse(0)?.expiresAt, now + 3600000)
  assert.equal(parseOAuthResponse("null", "test-refresh", now), null)
})
