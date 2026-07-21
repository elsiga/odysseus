import { useEffect, useState } from 'react'
import type { TaskRow } from '../db/db'
import { createTask, completeTask, deleteTask, liveTodayTasks } from '../db/repo/tasks'
import { useSyncStatus } from '../sync/status'
import './theme.css'

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
    <div className="tasks-screen">
      <h1 className="tasks-screen__title">Odysseus Tasks</h1>
      <span className="tasks-screen__sync">
        <span className={`tasks-screen__sync-dot tasks-screen__sync-dot--${syncStatus}`} />
        sync: {syncStatus}
      </span>

      <div className="tasks-screen__composer">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAdd()
          }}
          placeholder="Add a task…"
          aria-label="New task title"
        />
        <button
          className="tasks-screen__add-btn"
          onClick={() => void handleAdd()}
          disabled={!title.trim()}
        >
          Add
        </button>
      </div>

      {tasks.length === 0 ? (
        <p className="tasks-screen__empty">Today is clear.</p>
      ) : (
        <ul className="tasks-screen__list">
          {tasks.map((task) => {
            const done = Boolean(task.completedAt)
            return (
              <li key={task.id} className="task-row">
                <button
                  className={`task-row__check${done ? ' task-row__check--done' : ''}`}
                  onClick={() => void completeTask(task.id)}
                  disabled={done}
                  aria-label={done ? `${task.title} completed` : `Complete ${task.title}`}
                  aria-pressed={done}
                />
                <span className={`task-row__title${done ? ' task-row__title--done' : ''}`}>
                  {task.title}
                </span>
                <button
                  className="task-row__delete"
                  onClick={() => void deleteTask(task.id)}
                  aria-label={`Delete ${task.title}`}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
