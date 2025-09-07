# Cloudflare Workers Development

This file contains instructions for local development with Cloudflare Workers.

## Prerequisites

1. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```

2. Login to your Cloudflare account:
   ```bash
   wrangler login
   ```

## Local Development

To run the worker locally for development:

```bash
npm run dev:worker
```

This will start a local development server that you can use to test your worker before deploying.

## Environment Variables

For local development, you can set environment variables in a `.dev.vars` file:

```env
OPENROUTER_API_KEY=your-api-key
DEBUG=1
```

Note: Never commit this file to version control as it contains sensitive information.

## Testing

To test the worker locally, you can use curl or any HTTP client:

```bash
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-haiku-20240307",
    "messages": [
      {"role": "user", "content": "Hello, world!"}
    ]
  }'
```