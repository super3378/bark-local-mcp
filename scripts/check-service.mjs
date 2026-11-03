// Read-only check: no send_notification call exists in this script.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'bark-readonly-check', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--use-env-proxy', fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...process.env } }));
  const { tools } = await client.listTools();
  console.log(JSON.stringify({ tools: tools.map(tool => tool.name) }));
  const result = await client.callTool({ name: 'check_service', arguments: {} });
  console.log(JSON.stringify(result));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
