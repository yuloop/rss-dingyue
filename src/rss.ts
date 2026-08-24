import Parser from 'rss-parser';
import { store } from './store.js';
import type { RSSSource, RSSEntry } from './types.js';
import { getBeijingTime } from './time.js';
const parser = new Parser({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; RSS-Collector/1.0)'
  }
});

export async function fetchFeed(url: string) {
  return parser.parseURL(url);
}

export async function collectSource(source: RSSSource): Promise<number> {
  try {
    const feed = await fetchFeed(source.url);
    
    source.lastCheck = getBeijingTime();
    source.lastError = null;
    store.updateRSSSource(source);

    let newCount = 0;
    for (const item of feed.items) {
      const existing = store.getRSSEntryByLink(source.id, item.link || '');
      if (existing) continue;

      const entry: Omit<RSSEntry, 'id' | 'createdAt'> = {
        sourceId: source.id,
        title: item.title || '',
        link: item.link || '',
        description: item.contentSnippet || item.summary || '',
        content: item['content:encoded'] || item.content || '',
        pubDate: item.pubDate || getBeijingTime(),
        author: item.creator || item.author || '',
        summary: '',
        summarized: false,
        notified: false,
        summaryUpdatedAt: null
      };

      store.createRSSEntry(entry);
      newCount++;
    }

    return newCount;
  } catch (error) {
    source.lastError = (error as Error).message;
    store.updateRSSSource(source);
    throw error;
  }
}

export async function collectAll(): Promise<number> {
  const sources = store.getEnabledRSSSources();
  let totalNew = 0;

  for (const source of sources) {
    try {
      const count = await collectSource(source);
      totalNew += count;
      console.log(`Collected ${count} new entries from ${source.name}`);
    } catch (error) {
      console.error(`Collect ${source.name} failed:`, (error as Error).message);
    }
  }

  return totalNew;
}
