export type Bucket = 'today' | 'soon' | 'someday'
export interface Segment { text: string; kind: 'text' | 'project' | 'bucket' | 'time' | 'urgency' }
export interface Parsed {
  title: string
  project: string | null
  bucket: Bucket | null
  dueTime: string | null
  urgency: 0 | 1 | 2
  segments: Segment[]
}

// One combined matcher so segments are produced in source order.
const TOKEN = /(@[a-z0-9_-]+)|\b(today|soon|someday)\b|\b(\d{1,2}:\d{2}|\d{1,2}(?:am|pm))\b|(!+)/gi

export function parseCapture(text: string): Parsed {
  let project: string | null = null
  let bucket: Bucket | null = null
  let dueTime: string | null = null
  let urgency: 0 | 1 | 2 = 0
  const segments: Segment[] = []
  const titleParts: string[] = []

  let last = 0
  let m: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) {
      const plain = text.slice(last, m.index)
      segments.push({ text: plain, kind: 'text' })
      titleParts.push(plain)
    }
    const tok = m[0]
    if (m[1]) { project = tok.slice(1); segments.push({ text: tok, kind: 'project' }) }
    else if (m[2]) { bucket = tok.toLowerCase() as Bucket; segments.push({ text: tok, kind: 'bucket' }) }
    else if (m[3]) { dueTime = tok.toLowerCase(); segments.push({ text: tok, kind: 'time' }) }
    else if (m[4]) { urgency = (tok.length >= 2 ? 2 : 1) as 0 | 1 | 2; segments.push({ text: tok, kind: 'urgency' }) }
    last = m.index + tok.length
  }
  if (last < text.length) {
    const tail = text.slice(last)
    segments.push({ text: tail, kind: 'text' })
    titleParts.push(tail)
  }

  const title = titleParts.join('').replace(/\s+/g, ' ').trim()
  return { title, project, bucket, dueTime, urgency, segments }
}
