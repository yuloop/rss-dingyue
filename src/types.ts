export interface RSSSource {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  interval: number;
  notifyChannelIds: number[];
  lastCheck: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface RSSEntry {
  id: number;
  sourceId: number;
  sourceName?: string;
  title: string;
  link: string;
  description: string;
  content: string;
  pubDate: string;
  author: string;
  summary: string;
  summarized: boolean;
  notified: boolean;
  summaryUpdatedAt: string | null;
  createdAt: string;
}

export interface RSSSourceLatestEntry {
  id: number;
  title: string;
  version: string;
  link: string;
  pubDate: string;
  summary: string;
  summaryUpdatedAt: string | null;
  createdAt: string;
}

export interface RSSSourceOverview {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  lastCheck: string | null;
  lastError: string | null;
  createdAt: string;
  latestEntry: RSSSourceLatestEntry | null;
}

export interface NotifyConfig {
  id: number;
  name: string;
  type: 'webhook' | 'post' | 'get';
  url: string;
  headers: string;
  bodyTemplate: string;
  enabled: boolean;
}

export interface AIConfig {
  id: number;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  models: string[];
  maxTokens: number;
  enabled: boolean;
  isDefault: boolean;
  isFailover: boolean;
  failoverConfigId: number | null;
  priority: number;
}

export interface NotifyLog {
  id: number;
  entryId: number | null;
  title: string;
  content: string;
  status: 'success' | 'failed';
  error: string | null;
  sourceId: number | null;
  sourceName: string | null;
  notifyConfigId: number | null;
  notifyConfigName: string | null;
  createdAt: string;
}

export interface RSSPreviewItem {
  title: string;
  link: string;
  description: string;
  content: string;
  pubDate: string;
  author: string;
  summary?: string;
}

export interface SummaryCache {
  id: number;
  contentHash: string;
  title: string;
  summary: string;
  lastUsedAt: string;
  createdAt: string;
}

export interface Settings {
  key: string;
  value: string;
}

export interface CacheStats {
  rssEntries: number;
  notifyLogs: number;
  summaryCache: number;
}
