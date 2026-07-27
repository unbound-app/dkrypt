export function requestNotificationPermission(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  void Notification.requestPermission();
}

export function notifyJobFinished(title: string, body: string, downloadUrl?: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  const n = new Notification(title, { body, icon: '/favicon.svg' });
  n.onclick = () => {
    window.focus();
    if (downloadUrl) window.location.assign(downloadUrl);
    n.close();
  };
}
