import { access } from "node:fs/promises";
import { DrillError } from "./errors.js";
import { writePrivateFile } from "./report/json.js";

/** Three generic requests: one json_schema, one tool call, one plain text. */
export const STARTER_SAMPLES: Array<Record<string, unknown>> = [
  {
    messages: [
      { role: "system", content: "Extract the order details. Reply with JSON only." },
      { role: "user", content: "Hi, I'd like 3 of the blue mugs and 1 teapot, shipped to Leeds please." },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "order",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["items", "city"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["product", "quantity"],
                properties: { product: { type: "string" }, quantity: { type: "integer", minimum: 1 } },
              },
            },
            city: { type: "string" },
          },
        },
      },
    },
    max_tokens: 300,
  },
  {
    messages: [{ role: "user", content: "What's the weather in Lagos right now, in celsius?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Current weather for a city.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["city", "unit"],
            properties: { city: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
          },
        },
      },
    ],
    tool_choice: "auto",
    max_tokens: 200,
  },
  {
    messages: [
      { role: "system", content: "You are a concise support assistant." },
      { role: "user", content: "In two sentences, explain how to reset a forgotten password on a typical web app." },
    ],
    max_tokens: 200,
  },
];

export async function writeStarterSamples(path: string, force: boolean): Promise<void> {
  if (!force) {
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (exists) throw new DrillError(`"${path}" already exists.`, "Pass --force to overwrite it, or --samples <other file>.");
  }
  await writePrivateFile(path, STARTER_SAMPLES.map((s) => JSON.stringify(s)).join("\n") + "\n");
}
