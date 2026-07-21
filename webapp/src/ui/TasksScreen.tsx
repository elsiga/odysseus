import { useEffect, useState } from 'react'
import type { TaskRow } from '../db/db'
import { createTask, completeTask, deleteTask, liveTodayTasks } from '../db/repo/tasks'
import { useSyncStatus } from '../sync/status'

const POLL_MS = 1000

export default function TasksScreen() {
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [title, setTitle] = useState('')
  const syncStatus = useSyncStatus()

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      const rows = await liveTodayTasks()
      if (!cancelled) setTasks(rows)
    }
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  async function handleAdd() {
    const trimmed = title.trim()
    if (!trimmed) return
    await createTask({ title: trimmed, bucket: 'today' })
    setTitle('')
  }

  return (
    <div>
      <h1>Odysseus Tasks</h1>
      <p>Sync: {syncStatus}</p>
      <div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAdd()
          }}
          placeholder="Add a task…"
        />
        <button onClick={() => void handleAdd()}>Add</button>
      </div>
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <span style={task.completedAt ? { textDecoration: 'line-through' } : undefined}>{task.title}</span>{' '}
            {!task.completedAt && <button onClick={() => void completeTask(task.id)}>Complete</button>}{' '}
            <button onClick={() => void deleteTask(task.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
