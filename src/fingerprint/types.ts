export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementProps {
  role: string
  name: string
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
  resolveStatus: 'ok' | 'failed' | 'fallback'
  screenshotFile?: string | null
}

export interface Component {
  /** Composite key: regionKey/role["name"] or regionKey/role[index] */
  id: string
  props: ElementProps
  children?: Component[]
}

export interface Region {
  role: string
  bounds: Bounds
  background: string
  childCount: number
  /** Optional natural language summary — populated by --summarize (v2.1) */
  summary?: string
  /** Approximate token count for this region's YAML — Math.ceil(chars / 4) */
  _estimated_tokens?: number
  components: Component[]
}

export interface PageMeta {
  url: string
  title: string
  viewport: { width: number; height: number }
  theme: string
  background: string
  layout: string
  landmarks: string[]
  capturedAt: string
}

export interface FingerprintState {
  name: string
  modals: string
  selection: string | null
}

export interface VueComponentNode {
  name: string
  file?: string
  uid: number
  bounds: Bounds
  props: Record<string, unknown>
  descendantComponentCount: number
  children: VueComponentNode[]
  childrenTruncated?: boolean
  truncatedChildCount?: number
  screenshotFile?: string
}

export interface VueDetailEntry {
  name: string
  uid: number
  file?: string
  props: Record<string, unknown>
  setupState: Record<string, unknown>
  childUids: number[]
}

export interface VueDetailSidecar {
  capturedAt: string
  components: Record<string, VueDetailEntry>
}

export interface UIFingerprint {
  version: number
  page: PageMeta
  regions: Record<string, Region>
  ungrouped: Component[]
  state: FingerprintState
  vueComponents?: VueComponentNode[]
}

export interface InvariantFailure {
  component: string
  region: string
  property: string
  value: string | number | boolean
  message: string
  screenshotFile?: string | null
}

export interface InvariantReport {
  failures: InvariantFailure[]
  checked: number
}

export interface RegressionFailure {
  component: string
  region: string
  property: string
  expected: string | number | boolean
  actual: string | number | boolean
  screenshotFile?: string | null
}

export interface RegressionReport {
  failures: RegressionFailure[]
  checked: number
  missing: string[]
  added: string[]
}

export interface FullDiffReport {
  pass: boolean
  timestamp: string
  source: string
  target: string
  invariants: InvariantReport
  regressions: RegressionReport
}
