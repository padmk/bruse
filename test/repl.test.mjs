import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

async function server(t) {
  const child = spawn(process.execPath, ['browser/mcp/server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    clearTimeout(timer);
  });
  return {
    child,
    async request(method, params = {}) {
      const requestId = ++id;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No reply to ${method}: ${stderr}`)), 10000);
        pending.set(requestId, reply => { clearTimeout(timer); pending.delete(requestId); resolve(reply); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      });
    },
  };
}

async function cell(client, code) {
  const reply = await client.request('tools/call', { name: 'js', arguments: { code } });
  assert.equal(reply.result?.isError, false, JSON.stringify(reply));
  return reply.result.content.map(item => item.text).join('\n');
}

test('MCP ignores non-object JSON and answers subsequent requests', async t => {
  const client = await server(t);
  client.child.stdin.write('null\n42\nfalse\n"hello"\ninvalid json\n');
  const reply = await client.request('ping');
  assert.deepEqual(reply.result, {});
});

test('REPL persists and redeclares declarations across cells', async t => {
  const client = await server(t);
  await cell(client, 'let x = 1; const label = "first";');
  assert.match(await cell(client, 'nodeRepl.write([x, label])'), /1.*first/s);
  await cell(client, 'let x = 4;');
  assert.match(await cell(client, 'nodeRepl.write(x)'), /4/);
});

for (const [name, source, expected] of [
  ['postfix', 'x++\nlet after = 11', 11],
  ['prefix', '++x\nlet after = 12', 12],
  ['typeof before prefix', 'typeof ++x\nlet after = 13', 13],
  ['await before prefix', 'await ++x\nlet after = 14', 14],
  ['keyword property', 'obj.return++\nlet after = 15', 15],
]) {
  test(`REPL preserves declaration after ${name}`, async t => {
    const client = await server(t);
    await cell(client, 'let x = 1; let obj = { return: 1 };');
    await cell(client, source);
    assert.equal((await cell(client, 'nodeRepl.write(after)')).trim(), String(expected));
  });
}
