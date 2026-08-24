import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { store } from './store.js';
import type { AIConfig, RSSEntry } from './types.js';

// Global semaphore for AI concurrency (max 3 concurrent)
const MAX_CONCURRENT = 3;
let currentConcurrent = 0;
const queue: (() => void)[] = [];

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      currentConcurrent++;
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        currentConcurrent--;
        // Process next item in queue
        const next = queue.shift();
        if (next) next();
      }
    };

    if (currentConcurrent < MAX_CONCURRENT) {
      execute();
    } else {
      queue.push(execute);
    }
  });
}

// Track current model index for round-robin
let currentModelIndex = 0;

function getAIProvider(config: AIConfig) {
  return createOpenAI({
    baseURL: config.apiUrl,
    apiKey: config.apiKey,
  });
}

function getNextModel(config: AIConfig): string {
  const models = config.models || ['gpt-3.5-turbo'];
  if (models.length === 1) return models[0];
  
  // Round-robin model selection
  const model = models[currentModelIndex % models.length];
  currentModelIndex++;
  return model;
}

async function trySummarizeWithConfig(config: AIConfig, title: string, content: string): Promise<string> {
  const provider = getAIProvider(config);
  const model = getNextModel(config);
  
  const prompt = `请用简洁的中文总结以下文章内容（100字以内）：

标题：${title}

内容：
${content.substring(0, 3000)}

请直接输出总结内容，不要有任何前缀或解释。`;

  const { text } = await generateText({
    model: provider(model),
    prompt,
    maxTokens: config.maxTokens,
  });

  return text;
}

async function summarizeWithFailover(title: string, content: string): Promise<string> {
  const config = store.getDefaultAIConfig();
  if (!config) {
    throw new Error('No AI config available');
  }

  try {
    return await trySummarizeWithConfig(config, title, content);
  } catch (error) {
    console.error(`AI summarize failed with config ${config.name}:`, (error as Error).message);
    
    // Try failover config if available
    if (config.isFailover && config.failoverConfigId) {
      const failoverConfig = store.getAIConfigById(config.failoverConfigId);
      if (failoverConfig && failoverConfig.enabled) {
        console.log(`Trying failover config: ${failoverConfig.name}`);
        try {
          return await trySummarizeWithConfig(failoverConfig, title, content);
        } catch (failoverError) {
          console.error(`Failover config ${failoverConfig.name} also failed:`, (failoverError as Error).message);
        }
      }
    }
    
    throw error;
  }
}

export async function summarize(entry: RSSEntry): Promise<string> {
  const content = entry.content || entry.description;
  
  // Check cache first (no concurrency limit for cache)
  const contentHash = store.hashContent(entry.title, content);
  const cached = store.getSummaryCache(contentHash);
  if (cached) {
    store.updateSummaryCacheLastUsed(contentHash);
    return cached.summary;
  }
  
  // Generate new summary with concurrency limit
  const summary = await withConcurrencyLimit(() => summarizeWithFailover(entry.title, content));
  
  // Cache the result
  store.createSummaryCache({
    contentHash,
    title: entry.title,
    summary
  });
  
  return summary;
}

export async function summarizeContent(title: string, content: string): Promise<string> {
  // Check cache first (no concurrency limit for cache)
  const contentHash = store.hashContent(title, content);
  const cached = store.getSummaryCache(contentHash);
  if (cached) {
    store.updateSummaryCacheLastUsed(contentHash);
    return cached.summary;
  }
  
  // Generate new summary with concurrency limit
  const summary = await withConcurrencyLimit(() => summarizeWithFailover(title, content));
  
  // Cache the result
  store.createSummaryCache({
    contentHash,
    title,
    summary
  });
  
  return summary;
}

export async function testAIConfig(config: Omit<AIConfig, 'id'>): Promise<string> {
  const provider = getAIProvider(config as AIConfig);
  const models = config.models || ['gpt-3.5-turbo'];
  const model = models[0];
  
  const { text } = await generateText({
    model: provider(model),
    prompt: '请回复"AI连接测试成功"',
    maxTokens: 50,
  });

  return text;
}

export async function testAIConfigById(id: number): Promise<string> {
  const config = store.getAIConfigById(id);
  if (!config) {
    throw new Error('AI config not found');
  }
  return testAIConfig(config);
}
