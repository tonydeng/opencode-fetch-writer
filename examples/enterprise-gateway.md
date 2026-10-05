# Example: enterprise gateway with client fingerprint checks

Scenario: your provider is behind a gateway that

- only accepts requests from the official client (`my-corp-agent/2.1 (linux x86_64)` UA)
- treats the `x-legacy-affinity` header (added by some HTTP stacks) as a private protocol field and answers `403` when it sees one
- requires identification headers `X-Corp-Client-Name` / `X-Corp-Client-Version`

## OpenCode v2

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "corp-gateway": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://gateway.internal.example.com/v1",
        "apiKey": "{env:CORP_GATEWAY_API_KEY}"
      },
      "models": {
        "corp-pro": {}
      }
    }
  },
  "plugins": [
    {
      "package": "opencode-fetch-writer@0.3.0",
      "options": {
        "providerId": "corp-gateway",
        "uaTarget": "my-corp-agent/2.1 (linux x86_64)",
        "headersToStrip": ["x-legacy-affinity"],
        "headersToInject": {
          "X-Corp-Client-Name": "my-app",
          "X-Corp-Client-Version": "1.0"
        }
      }
    }
  ]
}
```

If you only need a UA fix and nothing else:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-fetch-writer@0.3.0",
      "options": {
        "providerId": "corp-gateway",
        "uaTarget": "my-corp-agent/2.1 (linux x86_64)"
      }
    }
  ]
}
```

Two gateways, one plugin entry (`providers` map):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-fetch-writer@0.3.0",
      "options": {
        "providers": {
          "corp-gateway": {
            "uaTarget": "my-corp-agent/2.1 (linux x86_64)",
            "headersToStrip": ["x-legacy-affinity"]
          },
          "partner-gw": {
            "uaTarget": "partner-client/1.0",
            "headersToInject": { "X-Partner-Client": "my-app" }
          }
        }
      }
    }
  ]
}
```

Verify at startup: stderr should show

```
[fetch-writer] registered http.request hook for provider "corp-gateway"
```

Note that the provider ID is the V2 canonical one. If you are migrating a V1
config, `azure-cognitive-services` becomes `azure` and
`google-vertex-anthropic` becomes `google-vertex`.

## OpenCode v1

Same rules, V1 config syntax (`provider` map with `npm` / `api`, and the
`plugin` tuple form):

```jsonc
{
  "provider": {
    "corp-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "api": "https://gateway.internal.example.com/v1",
      "options": {
        "apiKey": "{env:CORP_GATEWAY_API_KEY}"
      },
      "models": {
        "corp-pro": {}
      }
    }
  },
  "plugin": [
    ["opencode-fetch-writer@0.3.0", {
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

Verify at startup: stderr should show

```
[fetch-writer] patched options.fetch for provider "corp-gateway"
```

Requires OpenCode 1.18.29+ for the object entrypoint this package uses.