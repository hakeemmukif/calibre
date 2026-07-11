import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function GET() {
  const spec = readFileSync(join(process.cwd(), 'contract', 'openapi.json'), 'utf-8');
  const html = `<!doctype html>
<html>
  <head>
    <title>Caliber API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', { content: ${spec} });
    </script>
  </body>
</html>
`;
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html' } });
}
