/**
 * Minimal repro: workers-ai-provider + AI SDK tool calling across multiple turns.
 *
 * Turn 1: User asks to save a note → model calls save_note tool → works fine.
 * Turn 2: Send the full history (including tool call + tool result from turn 1)
 *          back to the model → "Unsupported role: tool" error?
 *
 * Hit /turn1 first, then /turn2 to reproduce.
 */

import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages, type UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";

interface Env {
  AI: Ai;
}

// Simple in-memory note store
const notes: string[] = [];

// Our tool
const saveNote = tool({
  description: "Save a note to memory",
  parameters: z.object({
    content: z.string().describe("The note to save"),
  }),
  execute: async ({ content }) => {
    notes.push(content);
    return `Saved note: "${content}"`;
  },
});

// Conversation history persisted across requests (in-memory for repro)
let history: UIMessage[] = [];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const workersai = createWorkersAI({ binding: env.AI });
    const model = workersai("@cf/moonshotai/kimi-k2.5");

    if (url.pathname === "/turn1") {
      // Reset
      history = [];
      notes.length = 0;

      // Add user message
      history.push({
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: 'Save this note: "Buy milk"' }],
      });

      const result = await generateText({
        model,
        system: "You are a helpful assistant. Use the save_note tool to save notes.",
        messages: await convertToModelMessages(history),
        tools: { save_note: saveNote },
        maxSteps: 3,
      });

      // Build assistant UIMessage with tool parts (like our session-memory example does)
      const parts: UIMessage["parts"] = [];
      const debugToolCalls: unknown[] = [];
      for (const step of result.steps) {
        for (const tc of step.toolCalls) {
          const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
          debugToolCalls.push({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            input: tc.input,
            inputType: typeof tc.input,
            inputKeys: tc.input ? Object.keys(tc.input as Record<string, unknown>) : null,
            resultValue: tr?.result,
            resultType: typeof tr?.result,
          });
          parts.push({
            type: "dynamic-tool",
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            state: tr ? "output-available" : "input-available",
            input: tc.input,
            ...(tr ? { output: tr.output } : {}),
          } as unknown as UIMessage["parts"][number]);
        }
      }
      console.log("TOOL CALLS DEBUG:", JSON.stringify(debugToolCalls, null, 2));
      if (result.text) {
        parts.push({ type: "text", text: result.text });
      }

      history.push({
        id: "assistant-1",
        role: "assistant",
        parts,
      });

      return Response.json({
        text: result.text,
        notes,
        historyLength: history.length,
        assistantParts: parts.map((p) => p.type),
      });
    }

    if (url.pathname === "/turn2") {
      if (history.length < 2) {
        return Response.json({ error: "Run /turn1 first" }, { status: 400 });
      }

      // Add a second user message
      history.push({
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "What notes do I have saved?" }],
      });

      try {
        // This should fail if workers-ai-provider can't handle tool role
        const result = await generateText({
          model,
          system: "You are a helpful assistant. Use the save_note tool to save notes.",
          messages: await convertToModelMessages(history),
          tools: { save_note: saveNote },
          maxSteps: 3,
        });

        return Response.json({
          text: result.text,
          success: true,
        });
      } catch (err) {
        return Response.json({
          error: (err as Error).message,
          stack: (err as Error).stack,
          historyDump: history.map((m) => ({
            id: m.id,
            role: m.role,
            partTypes: m.parts.map((p) => p.type),
          })),
        }, { status: 500 });
      }
    }

    // Also test: what does convertToModelMessages produce?
    if (url.pathname === "/debug") {
      if (history.length === 0) {
        return Response.json({ error: "Run /turn1 first" }, { status: 400 });
      }
      const modelMsgs = await convertToModelMessages(history);
      return Response.json(
        modelMsgs.map((m) => ({
          role: m.role,
          contentTypes: Array.isArray(m.content)
            ? m.content.map((c: { type: string }) => c.type)
            : typeof m.content,
        }))
      );
    }

    // Direct test: send tool role messages via raw ai.run to see what format works
    // Dump the full model messages and raw UIMessage parts
    if (url.pathname === "/model-msgs") {
      if (history.length === 0) {
        return Response.json({ error: "Run /turn1 first" }, { status: 400 });
      }
      const modelMsgs = await convertToModelMessages(history);
      return Response.json({
        modelMessages: modelMsgs,
        rawUIParts: history.map((m) => ({
          id: m.id,
          role: m.role,
          parts: m.parts,
        })),
      }, null, 2);
    }

    if (url.pathname === "/raw") {
      try {
        const result = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct" as Parameters<typeof env.AI.run>[0], {
          messages: [
            { role: "user", content: "Save a note: buy milk" },
            {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "save_note", arguments: JSON.stringify({ content: "buy milk" }) },
              }],
            },
            {
              role: "tool",
              tool_call_id: "call_1",
              content: "Saved note: buy milk",
            } as Record<string, unknown>,
            { role: "user", content: "What notes do I have?" },
          ],
          tools: [{
            type: "function",
            function: {
              name: "save_note",
              description: "Save a note",
              parameters: {
                type: "object",
                properties: { content: { type: "string" } },
                required: ["content"],
              },
            },
          }],
        } as Record<string, unknown>);
        return Response.json({ success: true, result });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    }

    if (url.pathname === "/ping") {
      const r = await generateText({
        model,
        prompt: "Say hello in one word.",
      });
      return Response.json({ text: r.text });
    }

    return Response.json({
      routes: {
        "/ping": "Simple test — no tools",
        "/turn1": "First turn — user asks to save a note, model uses tool",
        "/turn2": "Second turn — sends full history including tool parts back to model",
        "/debug": "Inspect what convertToModelMessages produces from the history",
      },
    });
  },
} satisfies ExportedHandler<Env>;
