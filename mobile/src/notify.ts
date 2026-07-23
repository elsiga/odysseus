export async function scheduleTestNotification(): Promise<void> {
  const w = window as any
  const LN = w.Capacitor?.Plugins?.LocalNotifications
  if (!LN) return
  await LN.requestPermissions()
  await LN.schedule({
    notifications: [{
      id: Math.floor(Math.random() * 1e6),
      title: 'Odysseus',
      body: 'Test reminder — timers will use this.',
      schedule: { at: new Date(Date.now() + 10_000) },  // 10s out; lock the screen to prove it
    }],
  })
}
