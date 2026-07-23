import { h, render } from 'preact'
import htm from 'htm'
export const html = htm.bind(h)
export { h, render }
export { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks'
