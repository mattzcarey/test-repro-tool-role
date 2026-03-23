# Repro: `convertToModelMessages` loses `input` from `dynamic-tool` UIMessage parts

## Bug

When a `UIMessage` contains `dynamic-tool` parts (from `generateText` tool calls), and you pass those messages back through `convertToModelMessages` on the next turn, the resulting model messages have `tool-call` content **without `input`**. This causes Workers AI (and likely other providers) to reject the request because `function.arguments` is required.

## Error

```
3030: 3 validation errors for ValidatorIterator
0.ChatCompletionMessageFunctionToolCallParam.function.arguments
  Field required [type=missing, input_value={'name': 'save_note'}, input_type=dict]
```

## Steps to reproduce

```bash
npm install
npx wrangler dev src/index.ts --port 8787
```

1. `curl http://localhost:8787/turn1` — model calls `save_note` tool, works fine
2. `curl http://localhost:8787/model-msgs` — shows the model messages that would be sent on turn 2. Note the `tool-call` has no `input` field
3. `curl http://localhost:8787/turn2` — fails with the `function.arguments` error

## Root cause

`convertToModelMessages` converts `dynamic-tool` UIMessage parts into model-level `tool-call` + `tool-result` messages, but drops the `input` field from the dynamic-tool part. The `tool-call` content ends up as:

```json
{ "type": "tool-call", "toolCallId": "...", "toolName": "save_note" }
```

Missing: `"input": { "content": "Buy milk" }`

## Versions

- `ai`: 6.0.136
- `workers-ai-provider`: 3.1.7
- Model: `@cf/moonshotai/kimi-k2.5` (also repros with `@cf/meta/llama-4-scout-17b-16e-instruct`)
