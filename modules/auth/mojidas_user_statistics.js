const DAY = 86400000;
const JST = 9 * 3600000;

function validVersion(client, platform) {
  return typeof client?.version === 'string' && client.version.length <= 40
    && (platform === 'macos' ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+\.\d+\.\d+$/).test(client.version);
}

function userStatistics(users, clients, now = Date.now()) {
  const today = Math.floor((now + JST) / DAY);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = today - 6 + index;
    const date = new Date(day * DAY).toISOString().slice(0, 10);
    return { date, label: `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`, count: 0 };
  });
  const platforms = [
    { label: 'Macのみ', count: 0, color: '#2563eb' },
    { label: 'Windowsのみ', count: 0, color: '#10b981' },
    { label: '両方', count: 0, color: '#8b5cf6' },
    { label: '未取得', count: 0, color: '#94a3b8' },
  ];
  for (const user of users) {
    const created = Date.parse(user.metadata?.creationTime);
    const index = Math.floor((created + JST) / DAY) - (today - 6);
    if (created <= now && index >= 0 && index < 7) days[index].count++;
    if (clients !== null) {
      const client = clients.get(user.uid);
      const mac = validVersion(client?.macos, 'macos');
      const win = validVersion(client?.windows, 'windows');
      platforms[mac && win ? 2 : mac ? 0 : win ? 1 : 3].count++;
    }
  }
  return { days, platforms: clients === null ? null : platforms, total: users.length };
}

module.exports = { userStatistics };
