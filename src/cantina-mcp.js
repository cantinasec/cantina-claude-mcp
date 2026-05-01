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
  const apiUrl = (process.env.CANTINA_API_URL || "https://api.cantina.xyz").replace(/\/+$/, "");
  if (!apiKey) {
    throw new Error(
      "CANTINA_API_KEY is required. Set it in your shell environment or in a .env file in the plugin directory."
    );
  }
  const rateLimitRpm = positiveInt(process.env.CANTINA_API_RATE_LIMIT_RPM, 120);
  return {
    apiKey,
    apiUrl,
    cacheTtlMs: nonNegativeInt(process.env.CANTINA_API_CACHE_TTL_MS, 6e4),
    maxRetries: nonNegativeInt(process.env.CANTINA_API_MAX_RETRIES, 4),
    minRequestIntervalMs: Math.ceil(6e4 / rateLimitRpm),
    rateLimitRpm,
    retryBaseMs: positiveInt(process.env.CANTINA_API_RETRY_BASE_MS, 1e3),
    timeoutMs: positiveInt(process.env.CANTINA_API_TIMEOUT_MS, 3e4)
  };
}
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
let requestQueue = Promise.resolve();
let nextRequestAt = 0;
async function scheduleApiRequest(config, run) {
  const task = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextRequestAt = Date.now() + config.minRequestIntervalMs;
    return run();
  });
  requestQueue = task.catch(() => {
  });
  return task;
}
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
function parseRetryAfter(response) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
  const timestamp = Date.parse(retryAfter);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return null;
}
function retryDelayMs(config, attempt, retryAfterMs) {
  if (retryAfterMs !== null && retryAfterMs !== void 0) return retryAfterMs;
  const backoff = Math.min(3e4, config.retryBaseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return backoff + jitter;
}
function shouldRetry(result) {
  return result.status === 0 || result.status === 429 || result.status === 502 || result.status === 503 || result.status === 504;
}
async function performApiRequest(config, url, options) {
  try {
    const response = await fetchWithTimeout(url, options, config.timeoutMs);
    let data;
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
      retryAfterMs: parseRetryAfter(response)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "Request failed",
      data: {
        type: "request_failed",
        msg: error instanceof Error ? error.message : "Request failed"
      },
      retryAfterMs: null
    };
  }
}
const responseCache = /* @__PURE__ */ new Map();
const inFlightRequests = /* @__PURE__ */ new Map();
async function cantinaApiRequest(config, apiPath, { method = "GET", body } = {}) {
  const url = `${config.apiUrl}${apiPath}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    }
  };
  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }
  const cacheKey = method === "GET" ? url : null;
  if (cacheKey && config.cacheTtlMs > 0) {
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true };
    }
    responseCache.delete(cacheKey);
  }
  if (cacheKey && inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }
  const request = scheduleApiRequest(config, async () => {
    let result;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      result = await performApiRequest(config, url, options);
      result.attempts = attempt + 1;
      if (result.ok || !shouldRetry(result) || attempt === config.maxRetries) break;
      await sleep(retryDelayMs(config, attempt, result.retryAfterMs));
    }
    if (cacheKey && result?.ok && config.cacheTtlMs > 0) {
      responseCache.set(cacheKey, {
        expiresAt: Date.now() + config.cacheTtlMs,
        result
      });
    }
    return result;
  });
  if (cacheKey) {
    inFlightRequests.set(cacheKey, request);
    try {
      return await request;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  }
  return request;
}
function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function apiErrorResult(result) {
  if (result.status === 429) {
    return errorResult(
      `Cantina API rate limit reached (429) after ${result.attempts || 1} attempt(s). Requests are serialized and retried with backoff, but Cantina still rejected this request. Try again shortly, avoid bulk fetching individual findings, or lower CANTINA_API_RATE_LIMIT_RPM.`
    );
  }
  if (result.status === 0) {
    return errorResult(`Cantina API request failed: ${formatApiErrorData(result.data)}`);
  }
  return errorResult(`Cantina API error (${result.status}): ${formatApiErrorData(result.data)}`);
}
function formatApiErrorData(data) {
  if (typeof data !== "string") return JSON.stringify(data);
  const compact = data.replace(/\s+/g, " ").trim();
  if (compact.startsWith("<html") || compact.includes("<title>429 Too Many Requests</title>")) {
    return "HTML error response from upstream proxy";
  }
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
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
    description: "IMPORTANT: Always use this tool for cantina.xyz URLs. Do NOT use WebFetch or Fetch for cantina.xyz \u2014 the site requires authentication and will redirect to a login page. This tool authenticates via API key.\n\nGet one specific security finding from Cantina by URL or by repo_id + finding_ref. Returns the finding title, description, severity, status, category, related files, and other metadata. For browsing or bulk work, call cantina_list_findings first and avoid repeatedly fetching individual findings unless the full details are needed.",
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
    description: "List and filter security findings in a Cantina repository. Returns a paginated list of findings with metadata. Use this for browsing, filtering, bulk triage, or looking for patterns across a repository's findings. Prefer this over many cantina_get_finding calls. Do NOT use WebFetch for cantina.xyz \u2014 always use this tool.",
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
        },
        next: {
          type: "string",
          description: "Pagination token from the previous response's nextValue field"
        },
        with_files: {
          type: "boolean",
          description: "Whether to include related_files. Set false when browsing lists to reduce response size."
        }
      },
      required: ["repo_id"]
    }
  },
  // ── Finding Comments ──
  {
    name: "cantina_list_finding_comments",
    description: "List comments on a finding in a Cantina repository. Uses the finding events endpoint and filters to only return comments (excluding status changes and other events). Each comment includes the author, content (Markdown), visibility, reactions, replies, and timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Repository UUID (required)"
        },
        finding_ref: {
          type: "string",
          description: "Finding number or ID within the repository (required)"
        }
      },
      required: ["repo_id", "finding_ref"]
    }
  },
  {
    name: "cantina_add_finding_comment",
    description: "Add a comment to an existing finding in a Cantina repository. The comment content should be valid Markdown. You can ping users with @username (for auditors/reviewers/judges/triagers in the repo) or @project (for all company users). Set visibility to control who can see the comment. Use parent to reply to an existing comment thread.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Repository UUID (required)"
        },
        finding_ref: {
          type: "string",
          description: "Finding number or ID within the repository (required)"
        },
        content: {
          type: "string",
          description: "Comment content in Markdown (required)"
        },
        visibility: {
          type: "string",
          enum: ["public", "private", "internal", "hidden"],
          description: "Comment visibility. 'public' = visible to all repo users, 'private' = visible to your team only, 'internal' = visible to judges/triagers/admins only, 'hidden' = hidden from all except admins. Defaults to public. Reviewers can only create public comments."
        },
        parent: {
          type: "string",
          description: "UUID of the parent comment to reply to. Creates a threaded reply. Threads are one level deep."
        }
      },
      required: ["repo_id", "finding_ref", "content"]
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
  if (!result.ok) return apiErrorResult(result);
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
  if (args.next) params.append("next", args.next);
  if (args.with_files !== void 0) params.append("with_files", String(args.with_files));
  const queryString = params.toString();
  const path2 = `/api/v0/repositories/${repoId}/findings${queryString ? `?${queryString}` : ""}`;
  const result = await cantinaApiRequest(config, path2);
  if (!result.ok) return apiErrorResult(result);
  return {
    content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }]
  };
}
async function handleListFindingComments(config, args) {
  const { repo_id, finding_ref } = args;
  if (!repo_id || !finding_ref) {
    return errorResult("Both 'repo_id' and 'finding_ref' are required.");
  }
  const result = await cantinaApiRequest(
    config,
    `/api/v0/repositories/${repo_id}/findings/${finding_ref}/events`
  );
  if (!result.ok) return apiErrorResult(result);
  const comments = (result.data.events || []).filter(e => e.type === "comment");
  return jsonResult(comments);
}
async function handleAddFindingComment(config, args) {
  const { repo_id, finding_ref, content, visibility, parent } = args;
  if (!repo_id || !finding_ref || !content) {
    return errorResult("'repo_id', 'finding_ref', and 'content' are required.");
  }
  const body = { content };
  if (visibility) body.visibility = visibility;
  if (parent) body.parent = parent;
  const result = await cantinaApiRequest(
    config,
    `/api/v0/repositories/${repo_id}/findings/${finding_ref}/comment`,
    { method: "POST", body }
  );
  if (!result.ok) return apiErrorResult(result);
  return jsonResult(result.data);
}
async function handleToolCall(config, name, args) {
  switch (name) {
    case "cantina_get_finding":
      return handleGetFinding(config, args);
    case "cantina_list_findings":
      return handleListFindings(config, args);
    case "cantina_list_finding_comments":
      return handleListFindingComments(config, args);
    case "cantina_add_finding_comment":
      return handleAddFindingComment(config, args);
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
