# Example: enterprise gateway with client fingerprint checks

Scenario: your provider is behind a gateway that

- only accepts requests from the official client (`my-corp-agent/2.1 (linux x86_64)` UA)
- treats the `x-legacy-affinity` header (added by some HTTP stacks) as a private protocol field and answers `403` when it sees one
- requires identification headers `X-Corp-Client-Name` / `X-Corp-Client-Version`

Full `opencode.jsonc` (v1 tuple syntax):

```jsonc
{
  "provider": {
    "corp-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://gateway.internal.example.com/v1",
        "apiKey": "{env:CORP_GATEWAY_API_KEY}"
      },
      "models": {
        "corp-pro": {}
      }
    }
  },
  "plugin": [
    ["opencode-fetch-writer@0.1.2", {
      "providerId": "corp-gateway",
      "uaTarget": "my-corp-agent/2.1 (linux x86_64)",
      "headersToStrip": ["x-legacy-affinity"],
      "headersToInject": {
        "X-Corp-Client-Name": "my-app",
        "X-Corp-Client-Version": "1.0"
      }
    }]
  ]
}
```

If you only need a UA fix and nothing else:

```jsonc
{
  "plugin": [
    ["opencode-fetch-writer@0.1.2", {
      "providerId": "corp-gateway",
      "uaTarget": "my-corp-agent/2.1 (linux x86_64)"
    }]
  ]
}
```

Verify at startup: stderr should show

```
[fetch-writer] patched options.fetch for provider "corp-gateway"
```
