#!/usr/bin/env node

// src/mcp-server.ts
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
function loadEnvFile() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(__dirname, "..", ".env"),
    path.resolve(__dirname, ".env")
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      const existing = process.env[key];
      if (!existing || existing.startsWith("${")) {
        process.env[key] = value;
      }
    }
    break;
  }
}
function getConfig() {
  loadEnvFile();
  const apiKey = process.env.CANTINA_API_KEY;
  const apiUrl = process.env.CANTINA_API_URL || "https://cantina.xyz";
  if (!apiKey) {
    throw new Error(
      "CANTINA_API_KEY is required. Set it in your shell environment or in a .env file in the plugin directory."
    );
  }
  return { apiKey, apiUrl };
}
async function cantinaApiRequest(config, path2) {
  const url = `${config.apiUrl}${path2}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    }
  });
  let data;
  const text = await response.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: response.ok, status: response.status, data };
}
function parseCantinaUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/code\/([^/]+)\/findings\/([^/]+)/);
    if (match) {
      return { repoId: match[1], findingRef: match[2] };
    }
    return null;
  } catch {
    return null;
  }
}
var TOOLS = [
  {
    name: "cantina_get_finding",
    description: "IMPORTANT: Always use this tool for cantina.xyz URLs. Do NOT use WebFetch or Fetch for cantina.xyz \u2014 the site requires authentication and will redirect to a login page. This tool authenticates via API key.\n\nGet a security finding from Cantina by URL or by repo_id + finding_ref. Returns the finding title, description, severity, status, category, related files, and other metadata.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Cantina finding URL, e.g. https://cantina.xyz/code/{repoId}/findings/{findingRef}"
        },
        repo_id: {
          type: "string",
          description: "Repository UUID (use with finding_ref instead of url)"
        },
        finding_ref: {
          type: "string",
          description: "Finding number or ID within the repository (use with repo_id instead of url)"
        }
      }
    }
  },
  {
    name: "cantina_list_findings",
    description: "List and filter security findings in a Cantina repository. Returns a paginated list of findings with metadata. Use this to browse findings, filter by severity or status, or look for patterns across a repository's findings. Do NOT use WebFetch for cantina.xyz \u2014 always use this tool.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Repository UUID (required)"
        },
        severity: {
          type: "string",
          description: "Comma-separated severity filter, e.g. 'critical,high'. Values: critical, high, medium, low, informational, gas_optimization"
        },
        status: {
          type: "string",
          description: "Comma-separated status filter, e.g. 'confirmed,fixed'. Values: new, in_review, disputed, rejected, spam, duplicate, confirmed, acknowledged, fixed, withdrawn"
        },
        duplicates: {
          type: "boolean",
          description: "Include duplicate findings (default: true)"
        },
        limit: {
          type: "number",
          description: "Maximum number of findings to return (default: 20, max: 100)"
        }
      },
      required: ["repo_id"]
    }
  }
];
async function handleGetFinding(config, args) {
  let repoId;
  let findingRef;
  if (args.url) {
    const parsed = parseCantinaUrl(args.url);
    if (!parsed) {
      return {
        content: [
          {
            type: "text",
            text: `Could not parse Cantina URL: ${args.url}
Expected format: https://cantina.xyz/code/{repoId}/findings/{findingRef}`
          }
        ],
        isError: true
      };
    }
    repoId = parsed.repoId;
    findingRef = parsed.findingRef;
  } else {
    repoId = args.repo_id;
    findingRef = args.finding_ref;
  }
  if (!repoId || !findingRef) {
    return {
      content: [
        {
          type: "text",
          text: "Either 'url' or both 'repo_id' and 'finding_ref' are required."
        }
      ],
      isError: true
    };
  }
  const result = await cantinaApiRequest(
    config,
    `/api/v0/repositories/${repoId}/findings/${findingRef}`
  );
  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: `Cantina API error (${result.status}): ${JSON.stringify(result.data)}`
        }
      ],
      isError: true
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }]
  };
}
async function handleListFindings(config, args) {
  const repoId = args.repo_id;
  if (!repoId) {
    return {
      content: [{ type: "text", text: "'repo_id' is required." }],
      isError: true
    };
  }
  const params = new URLSearchParams();
  if (args.severity) params.append("severity", args.severity);
  if (args.status) params.append("status", args.status);
  if (args.duplicates !== void 0) params.append("duplicates", String(args.duplicates));
  if (args.limit) params.append("limit", String(args.limit));
  const queryString = params.toString();
  const path2 = `/api/v0/repositories/${repoId}/findings${queryString ? `?${queryString}` : ""}`;
  const result = await cantinaApiRequest(config, path2);
  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: `Cantina API error (${result.status}): ${JSON.stringify(result.data)}`
        }
      ],
      isError: true
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }]
  };
}
async function handleToolCall(config, name, args) {
  switch (name) {
    case "cantina_get_finding":
      return handleGetFinding(config, args);
    case "cantina_list_findings":
      return handleListFindings(config, args);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true
      };
  }
}
function sendResponse(response) {
  const json = JSON.stringify(response);
  process.stdout.write(`${json}
`);
}
async function handleRequest(config, request) {
  const { id, method, params } = request;
  try {
    switch (method) {
      case "initialize":
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "cantina-mcp-server", version: "1.0.0" }
          }
        });
        break;
      case "notifications/initialized":
        break;
      case "tools/list":
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS }
        });
        break;
      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        const toolResult = await handleToolCall(config, toolName, toolArgs);
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: toolResult
        });
        break;
      }
      default:
        sendResponse({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        });
    }
  } catch (error) {
    sendResponse({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error"
      }
    });
  }
}
async function main() {
  const config = getConfig();
  console.error("Cantina MCP Server started");
  console.error(`API URL: ${config.apiUrl}`);
  console.error(`API Key: ${config.apiKey.substring(0, 4)}...`);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      await handleRequest(config, request);
    } catch (error) {
      console.error("Failed to parse request:", error);
    }
  });
  rl.on("close", () => {
    console.error("MCP Server shutting down");
    process.exit(0);
  });
}
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
