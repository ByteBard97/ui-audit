import type { Bounds } from '../fingerprint/types'

export interface VisualPropsResult {
  bounds: Bounds
  visible: boolean
  backgroundColor: string
  color: string
  fontSize: string
  fontFamily: string
  borderWidth: string
  opacity: string
  display: string
  overflow: string
  textOverflow: boolean
  textContent: string
  childCount: number
}

export const EXTRACT_FN_SOURCE = `function() {
  var el = this;
  var rect = el.getBoundingClientRect();
  var cs = window.getComputedStyle(el);
  return JSON.stringify({
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    backgroundColor: cs.backgroundColor,
    color: cs.color,
    fontSize: cs.fontSize,
    fontFamily: cs.fontFamily,
    borderWidth: cs.borderWidth,
    opacity: cs.opacity,
    display: cs.display,
    overflow: cs.overflow,
    textOverflow: el.scrollWidth > el.clientWidth,
    textContent: (el.textContent || '').trim().substring(0, 200),
    childCount: el.children.length,
  });
}`
