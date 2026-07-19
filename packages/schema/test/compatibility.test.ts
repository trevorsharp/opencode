import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FileSystem } from "../src/filesystem"
import { SessionV1 } from "../src/v1/session"

describe("schema compatibility", () => {
  test("moved class schemas remain constructible", () => {
    const input = new FileSystem.FindInput({ query: "src" })
    expect(input).toBeInstanceOf(FileSystem.FindInput)
    expect(input.query).toBe("src")
  })

  test("persisted structured output formats remain encodable", () => {
    const message = JSON.parse(
      JSON.stringify({
        info: {
          id: "msg_test",
          sessionID: "ses_test",
          role: "user",
          time: { created: 0 },
          format: new SessionV1.OutputFormatJsonSchema({
            type: "json_schema",
            schema: { type: "object" },
            retryCount: 2,
          }),
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        },
        parts: [],
      }),
    )

    expect(Schema.encodeUnknownSync(SessionV1.WithParts)(message)).toEqual(message)
  })
})
