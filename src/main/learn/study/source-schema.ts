export const learnSourceSchema = {
  type: "object", additionalProperties: false,
  properties: { file: { type: "string", minLength: 1 }, heading: { type: "string" },
    contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" }, quote: { type: "string", minLength: 1 } },
  required: ["file", "contentHash", "quote"],
};
