import { describe, expect, it } from 'vitest';
import { OpenAiApiProvider } from './api-providers.js';
import { IdelCliAgent } from './cli-agent.js';
import type { TerminalService } from '@openexecution/server';

async function finish(agent: IdelCliAgent, intent: string) {
  for await (const event of agent.ask(intent)) {
    if (event.type === 'error') throw new Error(event.message);
  }
}

describe('hosted conversation isolation', () => {
  it('keeps sequential and simultaneous asks out of each other’s provider history', async () => {
    const requests: { input: { content: string }[] }[] = [];
    const agent = new IdelCliAgent({
      service: {} as TerminalService,
      providerFactory: () => new OpenAiApiProvider({
        apiKey: 'test-only', system: 'test',
        fetch: async (_url, options) => {
          requests.push(JSON.parse(String(options?.body)));
          await new Promise(resolve => setTimeout(resolve, 1));
          return new Response(JSON.stringify({ output_text: JSON.stringify({ done: true, commands: [], explanation: 'Done' }) }));
        },
      }),
    });
    await finish(agent, 'first task');
    await finish(agent, 'second task');
    await Promise.all([finish(agent, 'tab A'), finish(agent, 'tab B')]);
    expect(requests.map(request => request.input.map(message => message.content)))
      .toEqual([['first task'], ['second task'], ['tab A'], ['tab B']]);
  });
});
