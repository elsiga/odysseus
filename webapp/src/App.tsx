import { useEffect } from 'react'
import { createSyncClient } from './sync/engine'
import TasksScreen from './ui/TasksScreen'

const syncClient = createSyncClient({ apiBase: '/api/sync', getToken: async () => null })

function App() {
  useEffect(() => {
    syncClient.start()
    return () => syncClient.stop()
  }, [])

  return <TasksScreen />
}

export default App
