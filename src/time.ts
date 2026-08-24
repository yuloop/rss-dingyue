// Get Beijing time string in ISO-like format
export function getBeijingTime(): string {
  const now = new Date();
  const beijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const year = beijing.getFullYear();
  const month = String(beijing.getMonth() + 1).padStart(2, '0');
  const day = String(beijing.getDate()).padStart(2, '0');
  const hour = String(beijing.getHours()).padStart(2, '0');
  const minute = String(beijing.getMinutes()).padStart(2, '0');
  const second = String(beijing.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

// Format date to Beijing time display
export function formatBeijingTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}
