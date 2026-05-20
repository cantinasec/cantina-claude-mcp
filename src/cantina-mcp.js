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
  const response = await fetch(url, options);
  let data;
  const text = await response.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: response.ok, status: response.status, data };
}
function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function apiErrorResult(result) {
  return errorResult(`Cantina API error (${result.status}): ${JSON.stringify(result.data)}`);
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
        search: {
          type: "string",
          description: "Search in finding title/description"
        },
        labels: {
          type: "string",
          description: "Comma-separated label filter"
        },
        submitter_id: {
          type: "string",
          description: "Filter by submitter UUID"
        },
        ordering: {
          type: "string",
          description: "Sort order. Values: created_at, severity, number"
        },
        limit: {
          type: "number",
          description: "Maximum number of findings to return (default: 20, max: 100)"
        },
        next: {
          type: "string",
          description: "Pagination cursor from previous response"
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
  },
  // ── Repositories ──
  {
    name: "cantina_list_repositories",
    description: "List Cantina repositories the authenticated user has access to. Returns paginated list with repository names, statuses, kinds, engagement info, and metadata. Filter by 'kind' to scope to a specific engagement type — for collaborative reviews use kind=collaborative_review.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Filter by repository kind. Values: scoping, collaborative_review, private_contest, public_contest, private_bounty, public_bounty"
        },
        status: {
          type: "string",
          description: "Filter by status. Values: draft, upcoming, live, judging, escalations, escalations_ended, complete, published"
        },
        limit: {
          type: "number",
          description: "Max results (default: 20)"
        },
        next: {
          type: "string",
          description: "Pagination cursor from previous response"
        },
        ordering: {
          type: "string",
          description: "Sort order"
        }
      }
    }
  },
  {
    name: "cantina_get_repository",
    description: "Get full details for a specific Cantina repository by its ID. Returns name, status, kind, engagement, company, timeframe, and other metadata.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Repository UUID (required)"
        }
      },
      required: ["repo_id"]
    }
  },
  // ── Bulk export ──
  {
    name: "cantina_export_findings",
    description: "Bulk export all findings (and their comment threads) from the authenticated user's Cantina collaborative-review repositories, grouped by repository. Intended for clients who want to import their audit data into their own AI systems. Use granular tools (cantina_list_findings, cantina_list_finding_comments) for incremental exploration; this tool is for full dumps and can return large payloads. Returns { exported_at, repository_count, finding_count, repositories: [{ ...repo, findings: [{ ...finding, comments: [...] }] }], truncated?: boolean }.",
    inputSchema: {
      type: "object",
      properties: {
        repo_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of repository UUIDs to limit the export. If omitted, exports all kind=collaborative_review repositories visible to the API key."
        },
        severity: {
          type: "string",
          description: "Optional comma-separated severity filter applied to each repo's findings. Values: critical, high, medium, low, informational, gas_optimization"
        },
        status: {
          type: "string",
          description: "Optional comma-separated finding status filter. Values: new, in_review, disputed, rejected, spam, duplicate, confirmed, acknowledged, fixed, withdrawn"
        },
        include_comments: {
          type: "boolean",
          description: "Include comment threads for each finding (default: true). Set to false for a lighter dump of just findings."
        }
      }
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
    return errorResult("'repo_id' is required.");
  }
  const params = new URLSearchParams();
  if (args.severity) params.append("severity", args.severity);
  if (args.status) params.append("status", args.status);
  if (args.duplicates !== void 0) params.append("duplicates", String(args.duplicates));
  if (args.search) params.append("search", args.search);
  if (args.labels) params.append("labels", args.labels);
  if (args.submitter_id) params.append("submitterId", args.submitter_id);
  if (args.ordering) params.append("ordering", args.ordering);
  if (args.limit) params.append("limit", String(args.limit));
  if (args.next) params.append("next", args.next);
  const queryString = params.toString();
  const apiPath = `/api/v0/repositories/${repoId}/findings${queryString ? `?${queryString}` : ""}`;
  const result = await cantinaApiRequest(config, apiPath);
  if (!result.ok) return apiErrorResult(result);
  return jsonResult(result.data);
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
async function handleListRepositories(config, args) {
  const params = new URLSearchParams();
  if (args.kind) params.append("kind", args.kind);
  if (args.status) params.append("status", args.status);
  if (args.limit) params.append("limit", String(args.limit));
  if (args.next) params.append("next", args.next);
  if (args.ordering) params.append("ordering", args.ordering);
  const queryString = params.toString();
  const apiPath = `/api/v0/repositories${queryString ? `?${queryString}` : ""}`;
  const result = await cantinaApiRequest(config, apiPath);
  if (!result.ok) return apiErrorResult(result);
  return jsonResult(result.data);
}

async function handleGetRepository(config, args) {
  if (!args.repo_id) {
    return errorResult("'repo_id' is required.");
  }
  const result = await cantinaApiRequest(
    config,
    `/api/v0/repositories/${args.repo_id}`
  );
  if (!result.ok) return apiErrorResult(result);
  return jsonResult(result.data);
}

// Bulk export configuration. The Cantina API caps findings per page at 100;
// we cap the total payload at MAX_FINDINGS_TOTAL to keep responses reasonable
// for LLM consumption. Clients can use repo_ids + filters to scope down.
const EXPORT_PAGE_SIZE = 100;
const MAX_FINDINGS_TOTAL = 2000;

async function fetchAllCollaborativeReviewRepos(config) {
  const repos = [];
  let next;
  do {
    const params = new URLSearchParams();
    params.append("kind", "collaborative_review");
    params.append("limit", String(EXPORT_PAGE_SIZE));
    if (next) params.append("next", next);
    const result = await cantinaApiRequest(
      config,
      `/api/v0/repositories?${params.toString()}`
    );
    if (!result.ok) {
      throw new Error(
        `Failed to list repositories (status ${result.status}): ${JSON.stringify(result.data)}`
      );
    }
    const data = result.data || {};
    const page = data.repositories || data.results || data.data || [];
    for (const repo of page) repos.push(repo);
    next = data.next || data.nextCursor || null;
  } while (next);
  return repos;
}

async function fetchAllFindingsForRepo(config, repoId, { severity, status }, remainingBudget) {
  const findings = [];
  let next;
  let budget = remainingBudget;
  do {
    if (budget <= 0) break;
    const params = new URLSearchParams();
    if (severity) params.append("severity", severity);
    if (status) params.append("status", status);
    params.append("limit", String(Math.min(EXPORT_PAGE_SIZE, budget)));
    if (next) params.append("next", next);
    const result = await cantinaApiRequest(
      config,
      `/api/v0/repositories/${repoId}/findings?${params.toString()}`
    );
    if (!result.ok) {
      throw new Error(
        `Failed to list findings for repo ${repoId} (status ${result.status}): ${JSON.stringify(result.data)}`
      );
    }
    const data = result.data || {};
    const page = data.findings || data.results || data.data || [];
    for (const finding of page) {
      findings.push(finding);
      budget--;
      if (budget <= 0) break;
    }
    next = data.next || data.nextCursor || null;
  } while (next);
  return findings;
}

async function fetchCommentsForFinding(config, repoId, findingRef) {
  const result = await cantinaApiRequest(
    config,
    `/api/v0/repositories/${repoId}/findings/${findingRef}/events`
  );
  if (!result.ok) {
    return { error: `Failed to fetch comments (status ${result.status})` };
  }
  return (result.data.events || []).filter((e) => e.type === "comment");
}

async function handleExportFindings(config, args) {
  const includeComments = args.include_comments !== false;
  const severity = args.severity;
  const status = args.status;

  let repos;
  try {
    if (Array.isArray(args.repo_ids) && args.repo_ids.length > 0) {
      repos = [];
      for (const repoId of args.repo_ids) {
        const result = await cantinaApiRequest(
          config,
          `/api/v0/repositories/${repoId}`
        );
        if (!result.ok) {
          return apiErrorResult(result);
        }
        repos.push(result.data);
      }
    } else {
      repos = await fetchAllCollaborativeReviewRepos(config);
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  const output = {
    exported_at: new Date().toISOString(),
    repository_count: repos.length,
    finding_count: 0,
    truncated: false,
    repositories: []
  };

  let totalBudget = MAX_FINDINGS_TOTAL;

  for (const repo of repos) {
    const repoId = repo.id;
    let repoFindings;
    try {
      repoFindings = await fetchAllFindingsForRepo(
        config,
        repoId,
        { severity, status },
        totalBudget
      );
    } catch (err) {
      output.repositories.push({
        ...repo,
        findings: [],
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }

    if (includeComments) {
      for (const finding of repoFindings) {
        const ref = finding.number ?? finding.id;
        if (ref == null) {
          finding.comments = [];
          continue;
        }
        finding.comments = await fetchCommentsForFinding(config, repoId, ref);
      }
    }

    output.repositories.push({ ...repo, findings: repoFindings });
    output.finding_count += repoFindings.length;
    totalBudget -= repoFindings.length;
    if (totalBudget <= 0) {
      output.truncated = true;
      break;
    }
  }

  return jsonResult(output);
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
    case "cantina_list_repositories":
      return handleListRepositories(config, args);
    case "cantina_get_repository":
      return handleGetRepository(config, args);
    case "cantina_export_findings":
      return handleExportFindings(config, args);
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
