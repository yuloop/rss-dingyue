import Database from 'better-sqlite3';
import crypto from 'crypto';
type DatabaseType = ReturnType<typeof Database>;
import type {
  RSSSource,
  RSSEntry,
  RSSSourceLatestEntry,
  RSSSourceOverview,
  NotifyConfig,
  AIConfig,
  NotifyLog,
  SummaryCache
} from './types.js';
import { getBeijingTime } from './time.js';

const dbPath = process.env.DATA_DIR || './data';

const db = new Database(`${dbPath}/rss.db`);

db.exec(`
  CREATE TABLE IF NOT EXISTS rss_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    interval INTEGER DEFAULT 30,
    notify_channel_ids TEXT DEFAULT '[]',
    last_check TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rss_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    description TEXT,
    content TEXT,
    pub_date TEXT,
    author TEXT,
    summary TEXT,
    summarized INTEGER DEFAULT 0,
    notified INTEGER DEFAULT 0,
    summary_updated_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, link)
  );

  CREATE TABLE IF NOT EXISTS notify_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    headers TEXT,
    body_template TEXT,
    enabled INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS ai_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    models TEXT DEFAULT '["gpt-3.5-turbo"]',
    max_tokens INTEGER DEFAULT 500,
    enabled INTEGER DEFAULT 1,
    is_default INTEGER DEFAULT 0,
    is_failover INTEGER DEFAULT 0,
    failover_config_id INTEGER,
    priority INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notify_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER,
    title TEXT,
    content TEXT,
    status TEXT,
    error TEXT,
    source_id INTEGER,
    source_name TEXT,
    notify_config_id INTEGER,
    notify_config_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS summary_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_hash TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    last_used_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);

// Migration: Add new columns to notify_logs if they don't exist
try {
  db.exec('ALTER TABLE notify_logs ADD COLUMN source_id INTEGER');
} catch {}
try {
  db.exec('ALTER TABLE notify_logs ADD COLUMN source_name TEXT');
} catch {}
try {
  db.exec('ALTER TABLE notify_logs ADD COLUMN notify_config_id INTEGER');
} catch {}
try {
  db.exec('ALTER TABLE notify_logs ADD COLUMN notify_config_name TEXT');
} catch {}

function parseNotifyChannelIds(str: string | null): number[] {
  if (!str) return [];
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
}

function parseModels(str: string | null): string[] {
  if (!str) return ['gpt-3.5-turbo'];
  try {
    return JSON.parse(str);
  } catch {
    return ['gpt-3.5-turbo'];
  }
}

function parseDateValue(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  const timestamp = Date.parse(dateStr);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function isRowNewer(candidate: Record<string, unknown>, current?: Record<string, unknown>): boolean {
  if (!current) return true;
  const candidateTime = parseDateValue(candidate.pub_date as string | null) || parseDateValue(candidate.created_at as string | null);
  const currentTime = parseDateValue(current.pub_date as string | null) || parseDateValue(current.created_at as string | null);
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }
  return (candidate.id as number) > (current.id as number);
}

function extractVersionLabel(title: string): string {
  const normalized = title.trim();
  if (!normalized) return '暂无版本';

  const versionMatch = normalized.match(/(?:^|[\s[(])((?:v|V)?\d+(?:\.\d+)+(?:[-._a-zA-Z0-9]+)?)/);
  if (versionMatch?.[1]) {
    return versionMatch[1];
  }

  return normalized.length > 80 ? `${normalized.substring(0, 77)}...` : normalized;
}

function hashContent(title: string, content: string): string {
  return crypto.createHash('md5').update(title + content).digest('hex');
}

export const store = {
  getRSSSources: (): RSSSource[] => {
    const rows = db.prepare('SELECT * FROM rss_sources').all() as Record<string, unknown>[];
    const latestTimeBySource = new Map<number, number>();
    for (const row of db.prepare('SELECT source_id, pub_date, created_at FROM rss_entries').all() as Record<string, unknown>[]) {
      const time = parseDateValue(row.pub_date as string | null) || parseDateValue(row.created_at as string | null);
      if (time > (latestTimeBySource.get(row.source_id as number) || 0)) {
        latestTimeBySource.set(row.source_id as number, time);
      }
    }
    const sources = rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      url: r.url as string,
      enabled: !!r.enabled,
      interval: r.interval as number,
      notifyChannelIds: parseNotifyChannelIds(r.notify_channel_ids as string),
      lastCheck: r.last_check as string | null,
      lastError: r.last_error as string | null,
      createdAt: r.created_at as string
    }));
    return sources.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const aTime = latestTimeBySource.get(a.id) || 0;
      const bTime = latestTimeBySource.get(b.id) || 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.id - b.id;
    });
  },

  getEnabledRSSSources: (): RSSSource[] => {
    const rows = db.prepare('SELECT * FROM rss_sources WHERE enabled = 1').all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      url: r.url as string,
      enabled: !!r.enabled,
      interval: r.interval as number,
      notifyChannelIds: parseNotifyChannelIds(r.notify_channel_ids as string),
      lastCheck: r.last_check as string | null,
      lastError: r.last_error as string | null,
      createdAt: r.created_at as string
    }));
  },

  getRSSSourceOverviews: (): RSSSourceOverview[] => {
    const sources = store.getRSSSources();
    const entryRows = db.prepare('SELECT * FROM rss_entries').all() as Record<string, unknown>[];
    const latestBySource = new Map<number, Record<string, unknown>>();

    for (const row of entryRows) {
      const sourceId = row.source_id as number;
      const current = latestBySource.get(sourceId);
      if (isRowNewer(row, current)) {
        latestBySource.set(sourceId, row);
      }
    }

    return sources.map(source => {
      const row = latestBySource.get(source.id);
      const latestEntry: RSSSourceLatestEntry | null = row ? {
        id: row.id as number,
        title: row.title as string,
        version: extractVersionLabel(row.title as string),
        link: row.link as string,
        pubDate: row.pub_date as string,
        summary: row.summary as string,
        summaryUpdatedAt: row.summary_updated_at as string | null,
        createdAt: row.created_at as string
      } : null;

      return {
        ...source,
        latestEntry
      };
    });
  },

  createRSSSource: (source: Omit<RSSSource, 'id' | 'lastCheck' | 'lastError' | 'createdAt'>): RSSSource => {
    const stmt = db.prepare('INSERT INTO rss_sources (name, url, enabled, `interval`, notify_channel_ids) VALUES (?, ?, ?, ?, ?)');
    const result = stmt.run(source.name, source.url, source.enabled ? 1 : 0, source.interval, JSON.stringify(source.notifyChannelIds || []));
    return { ...source, id: result.lastInsertRowid as number, lastCheck: null, lastError: null, createdAt: getBeijingTime() };
  },

  updateRSSSource: (source: RSSSource): void => {
    db.prepare('UPDATE rss_sources SET name = ?, url = ?, enabled = ?, `interval` = ?, notify_channel_ids = ?, last_check = ?, last_error = ? WHERE id = ?')
      .run(source.name, source.url, source.enabled ? 1 : 0, source.interval, JSON.stringify(source.notifyChannelIds || []), source.lastCheck, source.lastError, source.id);
  },

  deleteRSSSource: (id: number): void => {
    db.prepare('DELETE FROM rss_sources WHERE id = ?').run(id);
    db.prepare('DELETE FROM rss_entries WHERE source_id = ?').run(id);
  },

  deleteRSSEntriesBySource: (sourceId: number): number => {
    const result = db.prepare('DELETE FROM rss_entries WHERE source_id = ?').run(sourceId);
    return result.changes;
  },

  getRSSEntryCountBySource: (sourceId: number): number => {
    const result = db.prepare('SELECT COUNT(*) as count FROM rss_entries WHERE source_id = ?').get(sourceId) as { count: number };
    return result.count;
  },
  getRSSEntryByLink: (sourceId: number, link: string): RSSEntry | null => {
    return db.prepare('SELECT * FROM rss_entries WHERE source_id = ? AND link = ?').get(sourceId, link) as RSSEntry | null;
  },

  createRSSEntry: (entry: Omit<RSSEntry, 'id' | 'createdAt'>): RSSEntry => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO rss_entries 
      (source_id, title, link, description, content, pub_date, author, summary, summarized, notified) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(entry.sourceId, entry.title, entry.link, entry.description, entry.content, 
      entry.pubDate, entry.author, entry.summary, entry.summarized ? 1 : 0, entry.notified ? 1 : 0);
    const result = db.prepare('SELECT * FROM rss_entries WHERE source_id = ? AND link = ?').get(entry.sourceId, entry.link) as RSSEntry;
    return result;
  },

  getRSSEntries: (limit: number, offset: number, sourceId?: number): RSSEntry[] => {
    let sql = `SELECT e.*, s.name as source_name FROM rss_entries e 
               LEFT JOIN rss_sources s ON e.source_id = s.id`;
    const params: (number | string)[] = [];
    
    if (sourceId) {
      sql += ' WHERE e.source_id = ?';
      params.push(sourceId);
    }
    
    sql += ' ORDER BY e.pub_date DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      sourceId: r.source_id as number,
      sourceName: r.source_name as string,
      title: r.title as string,
      link: r.link as string,
      description: r.description as string,
      content: r.content as string,
      pubDate: r.pub_date as string,
      author: r.author as string,
      summary: r.summary as string,
      summarized: !!r.summarized,
      notified: !!r.notified,
      summaryUpdatedAt: r.summary_updated_at as string | null,
      createdAt: r.created_at as string
    }));
  },

  getRSSEntryById: (id: number): RSSEntry | null => {
    const row = db.prepare(`SELECT e.*, s.name as source_name FROM rss_entries e 
                            LEFT JOIN rss_sources s ON e.source_id = s.id WHERE e.id = ?`).get(id) as Record<string, unknown>;
    if (!row) return null;
    return {
      id: row.id as number,
      sourceId: row.source_id as number,
      sourceName: row.source_name as string,
      title: row.title as string,
      link: row.link as string,
      description: row.description as string,
      content: row.content as string,
      pubDate: row.pub_date as string,
      author: row.author as string,
      summary: row.summary as string,
      summarized: !!row.summarized,
      notified: !!row.notified,
      summaryUpdatedAt: row.summary_updated_at as string | null,
      createdAt: row.created_at as string
    };
  },

  getRSSEntriesBySource: (sourceId: number, limit: number): RSSEntry[] => {
    const rows = db.prepare('SELECT * FROM rss_entries WHERE source_id = ? ORDER BY pub_date DESC LIMIT ?').all(sourceId, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      sourceId: r.source_id as number,
      title: r.title as string,
      link: r.link as string,
      description: r.description as string,
      content: r.content as string,
      pubDate: r.pub_date as string,
      author: r.author as string,
      summary: r.summary as string,
      summarized: !!r.summarized,
      notified: !!r.notified,
      summaryUpdatedAt: r.summary_updated_at as string | null,
      createdAt: r.created_at as string
    }));
  },

  updateRSSEntry: (entry: RSSEntry): void => {
    db.prepare('UPDATE rss_entries SET summary = ?, summarized = ?, notified = ?, summary_updated_at = ? WHERE id = ?')
      .run(entry.summary, entry.summarized ? 1 : 0, entry.notified ? 1 : 0, entry.summaryUpdatedAt || null, entry.id);
  },

  getNotifyConfigs: (): NotifyConfig[] => {
    const rows = db.prepare('SELECT * FROM notify_configs').all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      type: r.type as 'webhook' | 'post' | 'get',
      url: r.url as string,
      headers: r.headers as string,
      bodyTemplate: r.body_template as string,
      enabled: !!r.enabled
    }));
  },

  getEnabledNotifyConfigs: (): NotifyConfig[] => {
    const rows = db.prepare('SELECT * FROM notify_configs WHERE enabled = 1').all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      type: r.type as 'webhook' | 'post' | 'get',
      url: r.url as string,
      headers: r.headers as string,
      bodyTemplate: r.body_template as string,
      enabled: !!r.enabled
    }));
  },

  getNotifyConfigByIds: (ids: number[]): NotifyConfig[] => {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM notify_configs WHERE id IN (${placeholders}) AND enabled = 1`).all(...ids) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      type: r.type as 'webhook' | 'post' | 'get',
      url: r.url as string,
      headers: r.headers as string,
      bodyTemplate: r.body_template as string,
      enabled: !!r.enabled
    }));
  },

  createNotifyConfig: (config: Omit<NotifyConfig, 'id'>): NotifyConfig => {
    const stmt = db.prepare('INSERT INTO notify_configs (name, type, url, headers, body_template, enabled) VALUES (?, ?, ?, ?, ?, ?)');
    const result = stmt.run(config.name, config.type, config.url, config.headers || '', config.bodyTemplate || '', config.enabled ? 1 : 0);
    return { ...config, id: result.lastInsertRowid as number };
  },

  updateNotifyConfig: (config: NotifyConfig): void => {
    db.prepare('UPDATE notify_configs SET name = ?, type = ?, url = ?, headers = ?, body_template = ?, enabled = ? WHERE id = ?')
      .run(config.name, config.type, config.url, config.headers || '', config.bodyTemplate || '', config.enabled ? 1 : 0, config.id);
  },

  deleteNotifyConfig: (id: number): void => {
    db.prepare('DELETE FROM notify_configs WHERE id = ?').run(id);
  },

  getAIConfigs: (): AIConfig[] => {
    const rows = db.prepare('SELECT * FROM ai_configs ORDER BY priority DESC, id ASC').all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      provider: r.provider as string,
      apiUrl: r.api_url as string,
      apiKey: r.api_key as string,
      models: parseModels(r.models as string),
      maxTokens: r.max_tokens as number,
      enabled: !!r.enabled,
      isDefault: !!r.is_default,
      isFailover: !!r.is_failover,
      failoverConfigId: r.failover_config_id as number | null,
      priority: r.priority as number
    }));
  },

  getAIConfigById: (id: number): AIConfig | null => {
    const row = db.prepare('SELECT * FROM ai_configs WHERE id = ?').get(id) as Record<string, unknown>;
    if (!row) return null;
    return {
      id: row.id as number,
      name: row.name as string,
      provider: row.provider as string,
      apiUrl: row.api_url as string,
      apiKey: row.api_key as string,
      models: parseModels(row.models as string),
      maxTokens: row.max_tokens as number,
      enabled: !!row.enabled,
      isDefault: !!row.is_default,
      isFailover: !!row.is_failover,
      failoverConfigId: row.failover_config_id as number | null,
      priority: row.priority as number
    };
  },
  getDefaultAIConfig: (): AIConfig | null => {
    const row = db.prepare('SELECT * FROM ai_configs WHERE enabled = 1 AND is_default = 1').get() as Record<string, unknown> | undefined;
    if (row) return {
      id: row.id as number,
      name: row.name as string,
      provider: row.provider as string,
      apiUrl: row.api_url as string,
      apiKey: row.api_key as string,
      models: parseModels(row.models as string),
      maxTokens: row.max_tokens as number,
      enabled: true,
      isDefault: true,
      isFailover: !!row.is_failover,
      failoverConfigId: row.failover_config_id as number | null,
      priority: row.priority as number
    };
    const fallback = db.prepare('SELECT * FROM ai_configs WHERE enabled = 1 ORDER BY priority DESC, id ASC').get() as Record<string, unknown> | undefined;
    if (!fallback) return null;
    return {
      id: fallback.id as number,
      name: fallback.name as string,
      provider: fallback.provider as string,
      apiUrl: fallback.api_url as string,
      apiKey: fallback.api_key as string,
      models: parseModels(fallback.models as string),
      maxTokens: fallback.max_tokens as number,
      enabled: true,
      isDefault: !!fallback.is_default,
      isFailover: !!fallback.is_failover,
      failoverConfigId: fallback.failover_config_id as number | null,
      priority: fallback.priority as number
    };
  },

  createAIConfig: (config: Omit<AIConfig, 'id'>): AIConfig => {
    if (config.isDefault) {
      db.prepare('UPDATE ai_configs SET is_default = 0').run();
    }
    const stmt = db.prepare('INSERT INTO ai_configs (name, provider, api_url, api_key, models, max_tokens, enabled, is_default, is_failover, failover_config_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const result = stmt.run(config.name, config.provider, config.apiUrl, config.apiKey, JSON.stringify(config.models || ['gpt-3.5-turbo']), config.maxTokens, config.enabled ? 1 : 0, config.isDefault ? 1 : 0, config.isFailover ? 1 : 0, config.failoverConfigId || null, config.priority || 0);
    return { ...config, id: result.lastInsertRowid as number };
  },

  updateAIConfig: (config: AIConfig): void => {
    if (config.isDefault) {
      db.prepare('UPDATE ai_configs SET is_default = 0 WHERE id != ?').run(config.id);
    }
    db.prepare('UPDATE ai_configs SET name = ?, provider = ?, api_url = ?, api_key = ?, models = ?, max_tokens = ?, enabled = ?, is_default = ?, is_failover = ?, failover_config_id = ?, priority = ? WHERE id = ?')
      .run(config.name, config.provider, config.apiUrl, config.apiKey, JSON.stringify(config.models || ['gpt-3.5-turbo']), config.maxTokens, config.enabled ? 1 : 0, config.isDefault ? 1 : 0, config.isFailover ? 1 : 0, config.failoverConfigId || null, config.priority || 0, config.id);
  },

  deleteAIConfig: (id: number): void => {
    db.prepare('DELETE FROM ai_configs WHERE id = ?').run(id);
  },

  createNotifyLog: (log: Omit<NotifyLog, 'id' | 'createdAt'>): void => {
    db.prepare('INSERT INTO notify_logs (entry_id, title, content, status, error, source_id, source_name, notify_config_id, notify_config_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(log.entryId, log.title, log.content, log.status, log.error || null, log.sourceId || null, log.sourceName || null, log.notifyConfigId || null, log.notifyConfigName || null);
  },

  getNotifyLogs: (limit: number): NotifyLog[] => {
    const rows = db.prepare('SELECT * FROM notify_logs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      entryId: r.entry_id as number,
      title: r.title as string,
      content: r.content as string,
      status: r.status as 'success' | 'failed',
      error: r.error as string | null,
      sourceId: r.source_id as number | null,
      sourceName: r.source_name as string | null,
      notifyConfigId: r.notify_config_id as number | null,
      notifyConfigName: r.notify_config_name as string | null,
      createdAt: r.created_at as string
    }));
  },
  getSummaryCache: (contentHash: string): SummaryCache | null => {
    const row = db.prepare('SELECT * FROM summary_cache WHERE content_hash = ?').get(contentHash) as Record<string, unknown>;
    if (!row) return null;
    return {
      id: row.id as number,
      contentHash: row.content_hash as string,
      title: row.title as string,
      summary: row.summary as string,
      lastUsedAt: row.last_used_at as string,
      createdAt: row.created_at as string
    };
  },

  createSummaryCache: (cache: Omit<SummaryCache, 'id' | 'lastUsedAt' | 'createdAt'>): SummaryCache => {
    const stmt = db.prepare('INSERT OR REPLACE INTO summary_cache (content_hash, title, summary) VALUES (?, ?, ?)');
    const result = stmt.run(cache.contentHash, cache.title, cache.summary);
    return { ...cache, id: result.lastInsertRowid as number, lastUsedAt: getBeijingTime(), createdAt: getBeijingTime() };
  },

  updateSummaryCacheLastUsed: (contentHash: string): void => {
    db.prepare('UPDATE summary_cache SET last_used_at = ? WHERE content_hash = ?').run(getBeijingTime(), contentHash);
  },

  cleanOldSummaryCaches: (daysOld: number = 30): number => {
    if (daysOld === 0) {
      const result = db.prepare('DELETE FROM summary_cache').run();
      return result.changes;
    }
    const result = db.prepare(`DELETE FROM summary_cache WHERE datetime(last_used_at) < datetime('now', '-' || ? || ' days')`).run(daysOld);
    return result.changes;
  },

  // Settings management
  getSetting: (key: string): string | null => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  },

  setSetting: (key: string, value: string): void => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  },

  // Cache cleanup functions
  cleanAllRSSEntries: (): number => {
    const result = db.prepare('DELETE FROM rss_entries').run();
    return result.changes;
  },

  cleanAllNotifyLogs: (): number => {
    const result = db.prepare('DELETE FROM notify_logs').run();
    return result.changes;
  },

  cleanAllSummaryCache: (): number => {
    const result = db.prepare('DELETE FROM summary_cache').run();
    return result.changes;
  },

  cleanAllCache: (): { rssEntries: number; notifyLogs: number; summaryCache: number } => {
    const rssEntries = db.prepare('DELETE FROM rss_entries').run().changes;
    const notifyLogs = db.prepare('DELETE FROM notify_logs').run().changes;
    const summaryCache = db.prepare('DELETE FROM summary_cache').run().changes;
    return { rssEntries, notifyLogs, summaryCache };
  },

  getCacheStats: (): { rssEntries: number; notifyLogs: number; summaryCache: number } => {
    const rssEntries = (db.prepare('SELECT COUNT(*) as count FROM rss_entries').get() as { count: number }).count;
    const notifyLogs = (db.prepare('SELECT COUNT(*) as count FROM notify_logs').get() as { count: number }).count;
    const summaryCache = (db.prepare('SELECT COUNT(*) as count FROM summary_cache').get() as { count: number }).count;
    return { rssEntries, notifyLogs, summaryCache };
  },

  hashContent
};

// 暴露 db 实例给 session store 使用（共享同一 SQLite 连接，避免多连接竞争）
export const rawDb: DatabaseType = db;

export default store;
