# Cantina MCP Server for Claude Code

An MCP server that lets Claude Code fetch and analyze Cantina security findings.

## What it does

- **Paste a finding link** — Claude fetches the full finding details (description, severity, related code)
- **"Find and fix this vuln"** — Claude reads the finding, then searches your codebase to locate and fix the issue
- **"Look for similar instances"** — Claude searches for similar findings in the repository
- **"Show me the comments"** — Claude fetches all comments on a finding
- **"Add a comment"** — Claude posts a comment to a finding on your behalf
- **"Export all my findings"** — Claude bulk-exports every finding (plus comment threads) from your collaborative-review repos, grouped by repository, so you can feed them into your own AI systems

## Setup

### 1. Clone this repo

```bash
git clone https://github.com/cantinasec/cantina-claude-mcp.git ~/cantina-mcp
```

### 2. Add to Claude Code

```bash
claude mcp add cantina -s user -e CANTINA_API_KEY=your-key-here -- node ~/cantina-mcp/src/cantina-mcp.js
```

That's it. The MCP server is now available in every Claude Code session.

## Usage

In Claude Code, paste a Cantina finding URL or ask about findings:

```
Look at this finding: https://cantina.xyz/code/abc123/findings/42
```

```
List all critical findings in repo abc123
```

```
Show me the comments on finding 42 in repo abc123
```

```
Add a comment to finding 42: "This looks like a reentrancy issue in the withdraw function"
```

### For clients on collaborative reviews

Export every finding and comment thread across all your collaborative reviews so you can feed them into your own AI systems:

```
Export all findings from my collaborative reviews
```

```
Export findings from my collaborative reviews, only high and critical severity
```

The result is a single JSON document grouped by repository, with each finding's comment thread inlined.

## Tools

- **`cantina_get_finding`** — Fetch a single finding by URL or by repo ID + finding number
- **`cantina_list_findings`** — List and filter findings in a repository by severity, status, labels, submitter, etc. Supports cursor pagination via `next`.
- **`cantina_list_finding_comments`** — List all comments on a finding (excludes status changes and other events)
- **`cantina_add_finding_comment`** — Add a comment to a finding, with optional visibility control and threading
- **`cantina_list_repositories`** — List repositories the API key can see; filter by `kind` (e.g. `collaborative_review`) and `status`
- **`cantina_get_repository`** — Get full metadata for a specific repository
- **`cantina_export_findings`** — Bulk export every finding (and optionally every comment thread) from your collaborative-review repos, grouped by repository. Capped at 2000 findings per call; scope with `repo_ids`, `severity`, or `status` if you exceed it.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CANTINA_API_KEY` | Yes | — | Your Cantina API key |
| `CANTINA_API_URL` | No | `https://cantina.xyz` | Cantina API base URL |

## Managing the MCP server

```bash
# Remove
claude mcp remove cantina -s user

# List all configured MCP servers
claude mcp list
```
