import { getProviderModels } from './llm.models.constants';

describe('getProviderModels', () => {
  it('includes GPT-5.2 for OpenAI Native', async () => {
    const models = await getProviderModels('openai-native');

    expect(models).toContain('gpt-5.2');
  });
});
