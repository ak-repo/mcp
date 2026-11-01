import { afterEach, beforeEach, expect, it } from 'vitest';
import { fixture, type Fixture } from '../tools/test-helpers.js';
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => f.close());
it('matches the complete tools, resources, templates, and prompts contract', async () => {
  const tools = await f.client.listTools();
  const resources = await f.client.listResources();
  const templates = await f.client.listResourceTemplates();
  const prompts = await f.client.listPrompts();
  tools.tools.sort((a, b) => a.name.localeCompare(b.name));
  resources.resources.sort((a, b) => a.uri.localeCompare(b.uri));
  templates.resourceTemplates.sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
  prompts.prompts.sort((a, b) => a.name.localeCompare(b.name));
  expect({ tools, resources, templates, prompts }).toMatchSnapshot();
});
