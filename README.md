# Cantina MCP Server for Claude Code

An MCP server that lets Claude Code fetch and analyze Cantina security findings.

## What it does

- **Paste a finding link** — Claude fetches the full finding details (description, severity, related code)
- **"Find and fix this vuln"** — Claude reads the finding, then searches your codebase to locate and fix the issue
- **"Look for similar instances"** — Claude searches for similar findings in the repository
- **"Show me the comments"** — Claude fetches all comments on a finding
- **"Add a comment"** — Claude posts a comment to a finding on your behalf

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

## Tools

- **`cantina_get_finding`** — Fetch a single finding by URL or by repo ID + finding number
- **`cantina_list_findings`** — List and filter findings in a repository by severity, status, etc.
- **`cantina_list_finding_comments`** — List all comments on a finding (excludes status changes and other events)
- **`cantina_add_finding_comment`** — Add a comment to a finding, with optional visibility control and threading

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
