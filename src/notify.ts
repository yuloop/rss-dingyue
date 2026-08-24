import { store } from './store.js';
import type { NotifyConfig, RSSEntry, RSSSource } from './types.js';
import { getBeijingTime, formatBeijingTime } from './time.js';
interface NotifyPayload {
  title: string;
  content: string;
  link: string;
  source: string;
  summary: string;
  time: string;
}

interface BatchNotifyItem {
  title: string;
  link: string;
  summary: string;
  time: string;
}

async function sendNotify(config: NotifyConfig, payload: NotifyPayload): Promise<void> {
  if (config.type === 'webhook') {
    const body: Record<string, unknown> = {
      msgtype: 'text',
      text: {
        content: payload.summary 
          ? `【${payload.source}】${payload.title}\n\n摘要：${payload.summary}\n\n链接：${payload.link}`
          : `【${payload.source}】${payload.title}\n${payload.link}`
      }
    };

    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Webhook failed: ${res.status} ${text}`);
    }
    return;
  }

  const method = config.type === 'get' ? 'GET' : 'POST';
  let url = config.url;
  let body: string | undefined;

  if (config.type === 'get') {
    url = config.url
      .replace(/\{\{Title\}\}/g, encodeURIComponent(payload.title))
      .replace(/\{\{Link\}\}/g, encodeURIComponent(payload.link))
      .replace(/\{\{Source\}\}/g, encodeURIComponent(payload.source))
      .replace(/\{\{Summary\}\}/g, encodeURIComponent(payload.summary))
      .replace(/\{\{Content\}\}/g, encodeURIComponent(payload.content))
      .replace(/\{\{Time\}\}/g, encodeURIComponent(payload.time));
  } else {
    body = config.bodyTemplate 
      ? config.bodyTemplate
          .replace(/\{\{Title\}\}/g, payload.title)
          .replace(/\{\{Link\}\}/g, payload.link)
          .replace(/\{\{Source\}\}/g, payload.source)
          .replace(/\{\{Summary\}\}/g, payload.summary)
          .replace(/\{\{Content\}\}/g, payload.content)
          .replace(/\{\{Time\}\}/g, payload.time)
      : JSON.stringify({
          title: payload.title,
          content: payload.content,
          link: payload.link,
          source: payload.source,
          summary: payload.summary
        });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.headers) {
    try {
      Object.assign(headers, JSON.parse(config.headers));
    } catch {}
  }

  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notify failed: ${res.status} ${text}`);
  }
}

async function sendBatchNotify(config: NotifyConfig, sourceName: string, items: BatchNotifyItem[]): Promise<void> {
  if (config.type === 'webhook') {
    // Format batch content for enterprise WeChat
    const content = items.map((item, i) => {
      const num = i + 1;
      if (item.summary) {
        return `${num}. ${item.title}\n   摘要：${item.summary}\n   链接：${item.link}`;
      }
      return `${num}. ${item.title}\n   链接：${item.link}`;
    }).join('\n\n');

    const body: Record<string, unknown> = {
      msgtype: 'text',
      text: {
        content: `【${sourceName}】更新 ${items.length} 条\n\n${content}`
      }
    };

    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Webhook failed: ${res.status} ${text}`);
    }
    return;
  }

  // For POST/GET, send first item as main content with count
  const firstItem = items[0];
  const payload: NotifyPayload = {
    title: `${firstItem.title} 等 ${items.length} 条更新`,
    content: items.map(i => i.title).join('\n'),
    link: firstItem.link,
    source: sourceName,
    summary: items.map(i => i.summary ? `• ${i.title}：${i.summary}` : `• ${i.title}`).join('\n'),
    time: getBeijingTime()
  };

  const method = config.type === 'get' ? 'GET' : 'POST';
  let url = config.url;
  let body: string | undefined;

  if (config.type === 'get') {
    url = config.url
      .replace(/\{\{Title\}\}/g, encodeURIComponent(payload.title))
      .replace(/\{\{Link\}\}/g, encodeURIComponent(payload.link))
      .replace(/\{\{Source\}\}/g, encodeURIComponent(payload.source))
      .replace(/\{\{Summary\}\}/g, encodeURIComponent(payload.summary))
      .replace(/\{\{Content\}\}/g, encodeURIComponent(payload.content))
      .replace(/\{\{Time\}\}/g, encodeURIComponent(payload.time));
  } else {
    body = config.bodyTemplate 
      ? config.bodyTemplate
          .replace(/\{\{Title\}\}/g, payload.title)
          .replace(/\{\{Link\}\}/g, payload.link)
          .replace(/\{\{Source\}\}/g, payload.source)
          .replace(/\{\{Summary\}\}/g, payload.summary)
          .replace(/\{\{Content\}\}/g, payload.content)
          .replace(/\{\{Time\}\}/g, payload.time)
      : JSON.stringify({
          title: payload.title,
          content: payload.content,
          link: payload.link,
          source: payload.source,
          summary: payload.summary,
          count: items.length
        });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.headers) {
    try {
      Object.assign(headers, JSON.parse(config.headers));
    } catch {}
  }

  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notify failed: ${res.status} ${text}`);
  }
}

// Single entry notify (for backward compatibility)
export async function notify(entry: RSSEntry, source: RSSSource): Promise<void> {
  const channelIds = source.notifyChannelIds || [];
  const configs = channelIds.length > 0 
    ? store.getNotifyConfigByIds(channelIds)
    : store.getEnabledNotifyConfigs();
  
  if (configs.length === 0) return;

  const payload: NotifyPayload = {
    title: entry.title,
    content: entry.description,
    link: entry.link,
    source: source.name,
    summary: entry.summary,
    time: formatBeijingTime(entry.pubDate)
  };

  for (const config of configs) {
    try {
      await sendNotify(config, payload);
      store.createNotifyLog({
        entryId: entry.id,
        title: entry.title,
        content: payload.summary || entry.description,
        status: 'success',
        error: null,
        sourceId: source.id,
        sourceName: source.name,
        notifyConfigId: config.id,
        notifyConfigName: config.name
      });
    } catch (error) {
      const errMsg = (error as Error).message;
      store.createNotifyLog({
        entryId: entry.id,
        title: entry.title,
        content: payload.summary || entry.description,
        status: 'failed',
        error: errMsg,
        sourceId: source.id,
        sourceName: source.name,
        notifyConfigId: config.id,
        notifyConfigName: config.name
      });
      console.error(`Notify ${config.name} failed:`, errMsg);
    }
  }
}

// Batch notify for multiple entries
export async function notifyBatch(entries: RSSEntry[], source: RSSSource): Promise<void> {
  if (entries.length === 0) return;
  
  const channelIds = source.notifyChannelIds || [];
  const configs = channelIds.length > 0 
    ? store.getNotifyConfigByIds(channelIds)
    : store.getEnabledNotifyConfigs();
  
  if (configs.length === 0) return;

  const items: BatchNotifyItem[] = entries.map(e => ({
    title: e.title,
    link: e.link,
    summary: e.summary || '',
    time: formatBeijingTime(e.pubDate)
  }));

  const titles = entries.map(e => e.title).join(', ');

  for (const config of configs) {
    try {
      await sendBatchNotify(config, source.name, items);
      store.createNotifyLog({
        entryId: entries[0].id,
        title: `${entries.length}条更新: ${titles.substring(0, 100)}`,
        content: items.map(i => i.summary || i.title).join('\n'),
        status: 'success',
        error: null,
        sourceId: source.id,
        sourceName: source.name,
        notifyConfigId: config.id,
        notifyConfigName: config.name
      });
    } catch (error) {
      const errMsg = (error as Error).message;
      store.createNotifyLog({
        entryId: entries[0].id,
        title: `批量通知失败: ${titles.substring(0, 50)}`,
        content: items.map(i => i.title).join('\n'),
        status: 'failed',
        error: errMsg,
        sourceId: source.id,
        sourceName: source.name,
        notifyConfigId: config.id,
        notifyConfigName: config.name
      });
      console.error(`Batch notify ${config.name} failed:`, errMsg);
    }
  }
}

export async function testNotify(config: Omit<NotifyConfig, 'id'>): Promise<void> {
  const payload: NotifyPayload = {
    title: '测试通知',
    content: '这是一条测试通知消息',
    link: 'https://example.com',
    source: 'RSS订阅系统',
    summary: '测试摘要内容',
    time: getBeijingTime()
  };

  await sendNotify(config as NotifyConfig, payload);
}

export async function sendTestNotify(config: NotifyConfig, payload: NotifyPayload): Promise<void> {
  await sendNotify(config, payload);
}
