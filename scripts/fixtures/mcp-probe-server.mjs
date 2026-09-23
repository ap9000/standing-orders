#!/usr/bin/env node
// A minimal MCP server over stdio for tests and live checks: one tool,
// `probe_status`, that answers whether PROBE_SECRET reached this process
// (its length only, never its value). Newline-delimited JSON-RPC.
import { createInterface } from "node:readline";

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1.0.0" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "probe_status", description: "Says whether the probe's secret reached it.", inputSchema: { type: "object", properties: {} } }] } });
  } else if (message.method === "tools/call") {
    const secret = process.env.PROBE_SECRET ?? "";
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `probe ok; secret ${secret === "" ? "missing" : `present (${secret.length} characters)`}` }] } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
