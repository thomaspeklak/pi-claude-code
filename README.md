# pi-claude-code

This Pi extension lets you use your Claude Pro or Max subscription in Pi by
routing all Claude model requests through the official Claude Code CLI.
It also supports explicitly configured gateways that hold provider credentials
outside the Claude Code process.

Pi still handles conversation history, approvals, compaction, and tool
execution. Claude Code only talks to the model. It never runs tools itself.

> [!WARNING]
> **The future of this extension is uncertain.** By default it works by running
> Pi's requests through the official Claude Code CLI in non-interactive mode
> (`claude -p`), and that usage counts against your normal Claude subscription
> limits. In May 2026 Anthropic
> [announced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
> that `claude -p`, Agent SDK, and third-party usage would move to a separate,
> smaller "Agent SDK credit" billed at API rates. Anthropic has since put that
> change on hold and says it will give advance notice before any future change.
>
> Until then the extension keeps working as described here, but that could
> change at any time. If Anthropic changes how `claude -p` usage is billed, this
> extension may cost more, stop drawing from your subscription, or stop working
> altogether. See Zed's
> [write-up](https://zed.dev/blog/anthropic-subscription-changes) for more
> background.

## Requirements

- Pi
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), installed and
  on your `PATH`:

  ```sh
  npm install -g @anthropic-ai/claude-code
  ```

- A Claude subscription that you are logged into with Claude Code, or a
  configured [gateway](#gateways)

## Installation

```sh
pi install https://github.com/earendil-works/pi-claude-code
```

Then pick a model from the **Claude Code (Experimental)** provider
in Pi.

## Login and logout

By default, Claude Code handles authentication. Log in and out with the Claude
Code CLI:

```sh
claude auth login
claude auth logout
```

The extension uses whatever login Claude Code currently has. You don't need
Pi's `/login` or `/logout` for this provider. The extension doesn't read, copy,
or store your Claude Code credentials.

Run `/claude-code-status` in Pi to check the executable and authentication
configuration.

## Configuration

These environment variables are optional:

- `PI_CLAUDE_CODE_COMMAND`: path or name of the Claude Code executable
  (default: `claude`).
- `PI_CLAUDE_CODE_CONFIG_DIR`: Claude Code config directory to use. The
  extension passes it to Claude Code as `CLAUDE_CONFIG_DIR`.
- `PI_CLAUDE_CODE_USE_GATEWAY`: opt into gateway authentication and routing
  as described below (disabled by default).

### Gateways

Gateway mode still runs the official Claude Code CLI. Claude sends its request
through the extension's local turn relay, which forwards it to your gateway.
Pi continues to own tools and conversation history.

Configure a trusted gateway explicitly. In this example, `GATEWAY_KEY` is the
gateway's client credential supplied by your existing credential setup:

```sh
export PI_CLAUDE_CODE_USE_GATEWAY=1
export PI_CLAUDE_CODE_COMMAND=/absolute/path/to/claude
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_AUTH_TOKEN="$GATEWAY_KEY"
pi
```

Set exactly one of `ANTHROPIC_AUTH_TOKEN` (Bearer authentication) or
`ANTHROPIC_API_KEY` (`x-api-key` authentication). This mode requires only the
gateway's client credential; the gateway's upstream credentials stay with it.
Bedrock, Vertex, Foundry and explicit Claude OAuth-token overrides remain
unsupported.

The base URL must use HTTPS or loopback HTTP. A path prefix is allowed; do not
append `/v1/messages`, because the relay adds it. The configured executable
must preserve the relay's injected `ANTHROPIC_BASE_URL`. Use the native Claude
binary or a launcher that preserves it; wrappers that replace it bypass the
relay and their responses are rejected.

Gateway mode does not run `claude auth status` or require a local subscription
login. `/claude-code-status` reports configuration, not successful connectivity
or model access. Send a small prompt to verify your gateway. Hosts embedding
the provider must also recognize gateway mode if they enforce their own local
subscription checks.

## Usage and billing

In the default mode, requests count against your Claude subscription's usage
quota and rate limits, the same as any other Claude Code usage. The extension
does not give you separate or unlimited usage.

To avoid silently changing how you're authenticated or billed, the extension
refuses API-key and proxy overrides unless gateway mode is explicitly enabled.
Bedrock, Vertex and Foundry overrides are always refused.

In gateway mode, the gateway determines upstream authentication, billing and
quota. The existing usage-credit guard still stops on overage reported by
Claude Code, but cannot establish how the gateway bills requests. Gateway
support does not establish eligibility for a particular provider account or
subscription.

## Limitations

- The extension is experimental.
- Branching, editing earlier messages, or changing settings mid-conversation
  starts a fresh Claude Code process that replays the conversation. The first
  response after that can be slower and may use more quota.
- Complex tool schemas (nullable types, `oneOf`, `allOf`, `anyOf`) may be
  simplified before Claude sees them.
- Adding or removing tools in the middle of a conversation keeps the prompt
  cache only on supported models. On other models it may use more quota.

For details on how the extension works internally, see
[ARCHITECTURE.md](ARCHITECTURE.md).
