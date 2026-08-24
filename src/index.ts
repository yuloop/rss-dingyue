import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import bcrypt from 'bcrypt';
import { store, rawDb } from './store.js';
import { SqliteSessionStore } from './session-store.js';
import { collectAll, collectSource, fetchFeed } from './rss.js';
import { summarize, summarizeContent, testAIConfig, testAIConfigById } from './ai.js';
import { notify, notifyBatch, testNotify, sendTestNotify } from './notify.js';
import { getBeijingTime, formatBeijingTime } from './time.js';
import type { RSSSource, RSSEntry, NotifyConfig, AIConfig, RSSPreviewItem } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 1471;
const SESSION_SECRET = process.env.SESSION_SECRET || 'rss-dingyue-secret-key-2024';
// 登录有效期：默认 30 天，可通过环境变量 SESSION_MAX_AGE_DAYS 覆盖
const SESSION_MAX_AGE_DAYS = parseInt(process.env.SESSION_MAX_AGE_DAYS || '30', 10);
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

app.use(cors({ credentials: true }));
app.use(express.json());

// Session middleware：使用 SQLite 持久化，重启不丢登录态；rolling 续期保证活跃用户不掉线
app.use(session({
  store: new SqliteSessionStore(rawDb),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS
  }
}));

// Auth constants
const DEFAULT_PASSWORD = 'admin123';
const SALT_ROUNDS = 12;

async function initializePassword(): Promise<void> {
  const existingHash = store.getSetting('passwordHash');
  if (!existingHash) {
    const hash = await bcrypt.hash(DEFAULT_PASSWORD, SALT_ROUNDS);
    store.setSetting('passwordHash', hash);
    console.log('Default password initialized: admin123');
  }
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized', authenticated: false });
  }
}

initializePassword().catch(console.error);

// Static files
app.use(express.static(path.join(__dirname, '../web/static')));
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, '../web/static/index.html'));
});

// ========== Auth API (no auth required) ==========

// Check auth status
app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }
  
  const hash = store.getSetting('passwordHash');
  if (!hash) {
    return res.status(500).json({ error: 'Password not initialized' });
  }
  
  try {
    const valid = await bcrypt.compare(password, hash);
    if (valid) {
      req.session.authenticated = true;
      res.json({ success: true, authenticated: true });
    } else {
      res.status(401).json({ error: 'Invalid password', success: false });
    }
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Change password (requires auth)
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  
  const hash = store.getSetting('passwordHash');
  if (!hash) {
    return res.status(500).json({ error: 'Password not initialized' });
  }
  
  try {
    const valid = await bcrypt.compare(currentPassword, hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    store.setSetting('passwordHash', newHash);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ========== Cache API (requires auth) ==========

// Get cache stats
app.get('/api/cache/stats', requireAuth, (_, res) => {
  res.json(store.getCacheStats());
});

// Clear all cache
app.post('/api/cache/clear-all', requireAuth, (_, res) => {
  const result = store.cleanAllCache();
  res.json({ 
    success: true, 
    message: `已清理: RSS条目 ${result.rssEntries} 条, 通知日志 ${result.notifyLogs} 条, 摘要缓存 ${result.summaryCache} 条`,
    ...result
  });
});

// Clear RSS entries only
app.post('/api/cache/clear-entries', requireAuth, (_, res) => {
  const count = store.cleanAllRSSEntries();
  res.json({ success: true, message: `已清理 ${count} 条RSS条目`, count });
});

// Clear notify logs only
app.post('/api/cache/clear-logs', requireAuth, (_, res) => {
  const count = store.cleanAllNotifyLogs();
  res.json({ success: true, message: `已清理 ${count} 条通知日志`, count });
});

// Clear summary cache only
app.post('/api/cache/clear-summary', requireAuth, (_, res) => {
  const count = store.cleanAllSummaryCache();
  res.json({ success: true, message: `已清理 ${count} 条摘要缓存`, count });
});

// ========== Protected API Routes ==========

// RSS Sources API
app.get('/api/sources', requireAuth, (_, res) => {
  res.json(store.getRSSSources());
});

app.get('/api/sources/overview', requireAuth, (_, res) => {
  res.json(store.getRSSSourceOverviews());
});

app.post('/api/sources', requireAuth, (req, res) => {
  const { name, url, enabled, interval, notifyChannelIds } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' });
  }
  const source = store.createRSSSource({ 
    name, 
    url, 
    enabled: enabled ?? true, 
    interval: interval ?? 30,
    notifyChannelIds: notifyChannelIds || []
  });
  res.json(source);
});

app.put('/api/sources', requireAuth, (req, res) => {
  const source = req.body as RSSSource;
  store.updateRSSSource(source);
  res.json(source);
});

app.delete('/api/sources', requireAuth, (req, res) => {
  const { id } = req.body;
  store.deleteRSSSource(id);
  res.json({ success: true });
});

app.delete('/api/sources/:id/entries', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const count = store.deleteRSSEntriesBySource(id);
  res.json({ success: true, message: `已清理 ${count} 条记录`, deletedCount: count });
});

app.get('/api/sources/:id/stats', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const count = store.getRSSEntryCountBySource(id);
  res.json({ entryCount: count });
});
app.post('/api/sources/test', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  try {
    const feed = await fetchFeed(url);
    const items: RSSPreviewItem[] = feed.items.slice(0, 10).map(item => ({
      title: item.title || '',
      link: item.link || '',
      description: item.contentSnippet || item.summary || '',
      content: item['content:encoded'] || item.content || '',
      pubDate: item.pubDate || '',
      author: item.creator || item.author || ''
    }));
    res.json({ success: true, title: feed.title, count: feed.items.length, items });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message, success: false });
  }
});

app.post('/api/sources/preview/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const sources = store.getRSSSources();
  const source = sources.find(s => s.id === id);
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }
  try {
    const feed = await fetchFeed(source.url);
    const items: RSSPreviewItem[] = feed.items.slice(0, 10).map(item => ({
      title: item.title || '',
      link: item.link || '',
      description: item.contentSnippet || item.summary || '',
      content: item['content:encoded'] || item.content || '',
      pubDate: item.pubDate || '',
      author: item.creator || item.author || ''
    }));
    res.json({ success: true, title: feed.title, count: feed.items.length, items });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message, success: false });
  }
});

app.post('/api/sources/test-workflow/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const sources = store.getRSSSources();
  const source = sources.find(s => s.id === id);
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }
  
  try {
    // 1. Fetch feed
    const feed = await fetchFeed(source.url);
    
    // 2. Find new entries (not in database yet)
    const newItems = [];
    for (const item of feed.items.slice(0, 10)) {
      const existing = store.getRSSEntryByLink(source.id, item.link || '');
      if (!existing) {
        newItems.push({
          title: item.title || '',
          link: item.link || '',
          description: item.contentSnippet || item.summary || '',
          content: item['content:encoded'] || item.content || '',
          pubDate: item.pubDate || '',
          author: item.creator || item.author || ''
        });
      }
    }
    
    if (newItems.length === 0) {
      return res.json({ 
        success: true, 
        hasUpdates: false, 
        message: '没有新更新',
        checkedCount: feed.items.length 
      });
    }
    
    // 3. Generate AI summaries for new items (parallel with global 3-concurrent limit)
    const summaryPromises = newItems.map(async (item) => {
      try {
        const summary = await summarizeContent(item.title, item.description || item.content);
        return { ...item, summary };
      } catch (e) {
        return { ...item, summary: '(AI总结失败: ' + (e as Error).message + ')' };
      }
    });
    const summarizedItems = await Promise.all(summaryPromises);
    
    // 4. Send notification
    const channelIds = source.notifyChannelIds || [];
    const configs = channelIds.length > 0 
      ? store.getNotifyConfigByIds(channelIds)
      : store.getEnabledNotifyConfigs();
    
    if (configs.length === 0) {
      return res.json({ 
        success: true, 
        hasUpdates: true, 
        message: `发现${newItems.length}个更新，但没有配置通知通道`,
        newCount: newItems.length,
        items: summarizedItems
      });
    }
    
    // Build notification content - send as one batch notification
    const notifyResults = [];
    const batchItems = summarizedItems.map(item => ({
      title: item.title,
      link: item.link,
      summary: item.summary || '',
      time: formatBeijingTime(item.pubDate)
    }));
    
    for (const config of configs) {
      try {
        // Send batch notification
        const content = batchItems.map((item, i) => {
          const num = i + 1;
          if (item.summary) {
            return `${num}. ${item.title}\n   摘要：${item.summary}\n   链接：${item.link}`;
          }
          return `${num}. ${item.title}\n   链接：${item.link}`;
        }).join('\n\n');
        
        const payload = {
          title: `${source.name} 更新 ${batchItems.length} 条`,
          content: content,
          link: batchItems[0].link,
          source: source.name,
          summary: batchItems.map(i => i.summary ? `• ${i.title}：${i.summary}` : `• ${i.title}`).join('\n'),
          time: getBeijingTime()
        };
        await sendTestNotify(config, payload);
        // Log success
        store.createNotifyLog({
          entryId: null,
          title: payload.title,
          content: content.substring(0, 500),
          status: 'success',
          error: null,
          sourceId: source.id,
          sourceName: source.name,
          notifyConfigId: config.id,
          notifyConfigName: config.name
        });
        notifyResults.push({ config: config.name, success: true });
      } catch (e) {
        const errMsg = (e as Error).message;
        // Log failure
        store.createNotifyLog({
          entryId: null,
          title: `${source.name} 更新 ${batchItems.length} 条`,
          content: batchItems.map(i => i.title).join(', '),
          status: 'failed',
          error: errMsg,
          sourceId: source.id,
          sourceName: source.name,
          notifyConfigId: config.id,
          notifyConfigName: config.name
        });
        notifyResults.push({ config: config.name, success: false, error: errMsg });
      }
    }
    res.json({ 
      success: true, 
      hasUpdates: true, 
      message: `发现${newItems.length}个更新，已发送通知`,
      newCount: newItems.length,
      items: summarizedItems,
      notifyResults
    });
    
  } catch (error) {
    res.status(400).json({ error: (error as Error).message, success: false });
  }
});
app.post('/api/collect', requireAuth, async (_, res) => {
  collectAll().catch(console.error);
  res.json({ success: true, message: '采集任务已启动' });
});

app.post('/api/cache/clear', requireAuth, (_, res) => {
  const count = store.cleanOldSummaryCaches(0); // Clear all cache
  res.json({ success: true, message: `已清理 ${count} 条缓存`, clearedCount: count });
});
// RSS Entries API
app.get('/api/entries', requireAuth, (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const sourceId = req.query.sourceId ? parseInt(req.query.sourceId as string) : undefined;
  const offset = (page - 1) * limit;
  res.json(store.getRSSEntries(limit, offset, sourceId));
});

app.get('/api/entries/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const entry = store.getRSSEntryById(id);
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  res.json(entry);
});

app.post('/api/entries/:id/summarize', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const entry = store.getRSSEntryById(id);
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  try {
    const summary = await summarize(entry);
    entry.summary = summary;
    entry.summarized = true;
    entry.summaryUpdatedAt = getBeijingTime();
    store.updateRSSEntry(entry);
    res.json({ success: true, summary });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message, success: false });
  }
});

app.post('/api/summarize', requireAuth, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }
  try {
    const summary = await summarizeContent(title, content);
    res.json({ success: true, summary });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message, success: false });
  }
});

// Notify Configs API
app.get('/api/notify', requireAuth, (_, res) => {
  res.json(store.getNotifyConfigs());
});

app.post('/api/notify', requireAuth, (req, res) => {
  const config = req.body as Omit<NotifyConfig, 'id'>;
  if (!config.name || !config.url) {
    return res.status(400).json({ error: 'Name and URL are required' });
  }
  const result = store.createNotifyConfig(config);
  res.json(result);
});

app.put('/api/notify', requireAuth, (req, res) => {
  const config = req.body as NotifyConfig;
  store.updateNotifyConfig(config);
  res.json(config);
});

app.delete('/api/notify', requireAuth, (req, res) => {
  const { id } = req.body;
  store.deleteNotifyConfig(id);
  res.json({ success: true });
});

app.post('/api/notify/test', requireAuth, async (req, res) => {
  const config = req.body as Omit<NotifyConfig, 'id'>;
  if (!config.url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  try {
    await testNotify(config);
    // Log test notification success
    store.createNotifyLog({
      entryId: null,
      title: '测试通知',
      content: `类型: ${config.type}, URL: ${config.url}`,
      status: 'success',
      error: null,
      sourceId: null,
      sourceName: null,
      notifyConfigId: null,
      notifyConfigName: config.name || '未命名'
    });
    res.json({ success: true, message: '通知发送成功' });
  } catch (error) {
    const errMsg = (error as Error).message;
    // Log test notification failure
    store.createNotifyLog({
      entryId: null,
      title: '测试通知',
      content: `类型: ${config.type}, URL: ${config.url}`,
      status: 'failed',
      error: errMsg,
      sourceId: null,
      sourceName: null,
      notifyConfigId: null,
      notifyConfigName: config.name || '未命名'
    });
    res.status(400).json({ error: errMsg, success: false });
  }
});

app.get('/api/notify/logs', requireAuth, (_, res) => {
  res.json(store.getNotifyLogs(100));
});

// AI Configs API
app.get('/api/ai', requireAuth, (_, res) => {
  res.json(store.getAIConfigs());
});

app.post('/api/ai', requireAuth, (req, res) => {
  const config = req.body as Omit<AIConfig, 'id'>;
  if (!config.name || !config.apiUrl || !config.apiKey) {
    return res.status(400).json({ error: 'Name, API URL and API Key are required' });
  }
  const result = store.createAIConfig(config);
  res.json(result);
});

app.put('/api/ai', requireAuth, (req, res) => {
  const config = req.body as AIConfig;
  store.updateAIConfig(config);
  res.json(config);
});

app.delete('/api/ai', requireAuth, (req, res) => {
  const { id } = req.body;
  store.deleteAIConfig(id);
  res.json({ success: true });
});

app.post('/api/ai/test', requireAuth, async (req, res) => {
  const config = req.body as Omit<AIConfig, 'id'>;
  if (!config.apiUrl || !config.apiKey) {
    return res.status(400).json({ error: 'API URL and API Key are required' });
  }
  try {
    const result = await testAIConfig(config);
    res.json({ success: true, message: 'AI连接成功', response: result });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message, success: false });
  }
});

app.post('/api/ai/test/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await testAIConfigById(id);
    res.json({ success: true, message: 'AI连接成功', response: result });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message, success: false });
  }
});

// Process new entries
async function processNewEntries(): Promise<void> {
  const sources = store.getEnabledRSSSources();
  
  for (const source of sources) {
    try {
      const count = await collectSource(source);
      if (count > 0) {
        console.log(`Collected ${count} new entries from ${source.name}`);
        
        const entries = store.getRSSEntriesBySource(source.id, count);
        // Summarize all new entries first (parallel with global 3-concurrent limit)
        const entriesToSummarize = entries.filter(e => !e.summarized);
        const summarizePromises = entriesToSummarize.map(async (entry) => {
          try {
            const summary = await summarize(entry);
            entry.summary = summary;
            entry.summarized = true;
            entry.summaryUpdatedAt = getBeijingTime();
            store.updateRSSEntry(entry);
          } catch (error) {
            console.error(`Summarize failed:`, (error as Error).message);
          }
        });
        await Promise.all(summarizePromises);
        
        // Collect entries to notify
        const toNotify: RSSEntry[] = entries.filter(e => !e.notified);
        
        // Send batch notification for all entries
        if (toNotify.length > 0) {
          try {
            await notifyBatch(toNotify, source);
            // Mark all as notified
            for (const entry of toNotify) {
              entry.notified = true;
              store.updateRSSEntry(entry);
            }
          } catch (error) {
            console.error(`Batch notify failed:`, (error as Error).message);
          }
        }
      }
    } catch (error) {
      console.error(`Process ${source.name} failed:`, (error as Error).message);
    }
  }
}

// Schedule cron job (every 5 minutes)
cron.schedule('*/5 * * * *', () => {
  console.log('Starting scheduled RSS collection...');
  processNewEntries().catch(console.error);
});

// Start server
app.listen(PORT, () => {
  console.log(`RSS订阅系统启动在端口 ${PORT}`);
});
