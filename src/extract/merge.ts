import type { Page } from 'playwright'
import type { UIFingerprint, Region, Component, ElementProps, VueComponentNode } from '../fingerprint/types'
import { extractAccessibilityTree, type AXNode } from './accessibility'
import { discoverRegions, type DiscoveryConfig, type DiscoveryResult } from './region-discovery'
import { batchResolveVisualProps, type ResolvedNode } from './cdp-resolve'
import type { VisualPropsResult } from './visual-props'
import { buildVueTree } from './vue-walker'

export interface BuildOptions {
  stateName?: string
  discoveryConfig?: DiscoveryConfig
  outDir?: string
  vueDepth?: number
}

/**
 * Build a complete UIFingerprint by:
 *   1. Discovering regions (landmark -> semantic HTML -> config fallback)
 *   2. Extracting the accessibility tree for child enumeration
 *   3. Resolving all relevant AX nodes to visual properties via CDP
 *   4. Merging into the hierarchical UIFingerprint structure
 */
export async function buildFingerprint(
  page: Page,
  options?: BuildOptions,
): Promise<UIFingerprint> {
  const url = page.url()
  const title = await page.title()
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 }

  // Step 1: Discover regions (returns AX tree for reuse — single CDP call)
  const discovery: DiscoveryResult = await discoverRegions(page, options?.discoveryConfig)
  const discoveredRegions = discovery.regions
  // Reuse AX tree from discovery — avoids a second CDP Accessibility.getFullAXTree call
  const axTree = discovery.axTree ?? await extractAccessibilityTree(page)

  // Step 3: Collect all backendDOMNodeIds we need to resolve
  const allNodeIds = new Set<number>()
  for (const region of discoveredRegions) {
    if (region.backendDOMNodeId) allNodeIds.add(region.backendDOMNodeId)
  }

  // Map each discovered region to its AX children
  const landmarkChildMap = buildLandmarkChildMap(axTree, discoveredRegions)
  for (const children of landmarkChildMap.values()) {
    for (const child of children) {
      if (child.backendDOMNodeId) allNodeIds.add(child.backendDOMNodeId)
    }
  }

  // Step 4: Batch resolve all nodes to visual properties
  const resolvedProps = await batchResolveVisualProps(page, [...allNodeIds])

  // Step 5: Extract body background for page-level metadata
  const bodyBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  )

  // Step 6: Build the fingerprint
  const regions: Record<string, Region> = {}

  for (const discovered of discoveredRegions) {
    const regionKey = buildRegionKey(discovered.role, discovered.name)

    // Get region visual props from CDP, with selector fallback
    let regionVisual: ResolvedNode | undefined
    if (discovered.backendDOMNodeId) {
      regionVisual = resolvedProps.get(discovered.backendDOMNodeId)
    }
    if (!regionVisual) {
      regionVisual = await extractViaSelector(page, discovered.selector)
      if (!regionVisual) continue
    }

    // Build child components from AX tree children (keyed by backendDOMNodeId to avoid role collisions)
    const children = discovered.backendDOMNodeId
      ? landmarkChildMap.get(discovered.backendDOMNodeId) ?? []
      : []
    const components = buildComponents(regionKey, children, resolvedProps)

    regions[regionKey] = {
      role: discovered.role,
      bounds: regionVisual.bounds,
      background: regionVisual.backgroundColor,
      childCount: regionVisual.childCount,
      components,
    }
  }

  // Inject data-testid elements as components into their containing region
  const ungrouped: Component[] = []
  if (discovery.testIdElements.length > 0) {
    for (const testIdEl of discovery.testIdElements) {
      const visual = await extractViaSelector(page, testIdEl.selector)
      if (!visual || !visual.visible) continue

      // Find which region contains this element by bounds overlap
      const containingRegion = findContainingRegion(regions, visual.bounds)
      if (containingRegion) {
        const [regionKey, region] = containingRegion
        const compId = `${regionKey}/testid["${testIdEl.testId}"]`
        // Skip if a component with this ID already exists
        if (region.components.some(c => c.id === compId)) continue

        region.components.push({
          id: compId,
          props: { role: 'generic', name: testIdEl.testId, ...visual, resolveStatus: 'fallback' as const },
        })
      } else {
        // Element is outside all regions — add to ungrouped
        ungrouped.push({
          id: `ungrouped/testid["${testIdEl.testId}"]`,
          props: { role: 'generic', name: testIdEl.testId, ...visual, resolveStatus: 'fallback' as const },
        })
      }
    }
  }

  // Vue layer — optional, non-breaking; only runs when outDir is provided
  let vueComponents: VueComponentNode[] | undefined
  if (options?.outDir) {
    try {
      vueComponents = (await buildVueTree(page, options.outDir, options.vueDepth)) ?? undefined
    } catch (err) {
      console.warn('[vue-walker] buildVueTree failed, skipping:', err)
    }
  }

  return {
    version: 2,
    page: {
      url,
      title,
      viewport,
      theme: inferTheme(bodyBg),
      background: bodyBg,
      layout: inferLayout(regions),
      landmarks: discoveredRegions.map(r => r.role),
      capturedAt: new Date().toISOString(),
    },
    regions,
    ungrouped,
    vueComponents,
    state: {
      name: options?.stateName ?? 'default',
      modals: 'none',
      selection: null,
    },
  }
}

/**
 * Map each region's backendDOMNodeId to its direct AX children for component enumeration.
 * Keyed by backendDOMNodeId (not role) to avoid collisions when multiple regions share
 * the same role (e.g., two <nav> elements).
 */
function buildLandmarkChildMap(
  tree: AXNode,
  regions: Array<{ role: string; backendDOMNodeId?: number }>,
): Map<number, AXNode[]> {
  const result = new Map<number, AXNode[]>()
  const targetIds = new Set(
    regions.map(r => r.backendDOMNodeId).filter((id): id is number => id != null),
  )

  function walk(node: AXNode) {
    if (node.backendDOMNodeId && targetIds.has(node.backendDOMNodeId)) {
      result.set(node.backendDOMNodeId, node.children ?? [])
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return result
}

/** Build Component[] from AX children, skipping generic/none roles */
function buildComponents(
  regionKey: string,
  children: AXNode[],
  resolvedProps: Map<number, ResolvedNode>,
): Component[] {
  const components: Component[] = []
  const nameCounts = new Map<string, number>()

  for (const child of children) {
    if (child.role === 'none' || child.role === 'generic') continue

    const compId = buildComponentId(regionKey, child, nameCounts)

    let childVisual: ResolvedNode | undefined
    if (child.backendDOMNodeId) {
      childVisual = resolvedProps.get(child.backendDOMNodeId)
    }

    const props: ElementProps = childVisual
      ? {
          role: child.role,
          name: child.name,
          ...childVisual,
          resolveStatus: 'ok' as const,
        }
      : {
          role: child.role,
          name: child.name,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          visible: false,
          backgroundColor: '',
          color: '',
          fontSize: '',
          fontFamily: '',
          borderWidth: '',
          opacity: '0',
          display: '',
          overflow: '',
          textOverflow: false,
          textContent: child.name,
          childCount: child.children?.length ?? 0,
          resolveStatus: 'failed' as const,
        }

    components.push({ id: compId, props })
  }

  return components
}

/** Build a composite component ID: regionKey/role["name"] or regionKey/role[index] */
function buildComponentId(
  regionKey: string,
  child: AXNode,
  nameCounts: Map<string, number>,
): string {
  if (child.name) {
    return `${regionKey}/${child.role}["${child.name}"]`
  }
  const key = `${regionKey}/${child.role}`
  const count = nameCounts.get(key) ?? 0
  nameCounts.set(key, count + 1)
  return `${key}[${count}]`
}

/** Fallback: extract visual props via CSS selector when CDP resolve is unavailable */
async function extractViaSelector(
  page: Page,
  selector: string,
): Promise<VisualPropsResult | undefined> {
  const count = await page.locator(selector).count()
  if (count === 0) return undefined

  return page.locator(selector).first().evaluate(/** Same properties as EXTRACT_FN_SOURCE in visual-props.ts (no JSON.stringify — evaluate returns objects directly) */ (el) => {
    const rect = el.getBoundingClientRect()
    const cs = window.getComputedStyle(el)
    const h = el as HTMLElement
    return {
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        cs.visibility !== 'hidden' &&
        cs.display !== 'none',
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      borderWidth: cs.borderWidth,
      opacity: cs.opacity,
      display: cs.display,
      overflow: cs.overflow,
      textOverflow: h.scrollWidth > h.clientWidth,
      textContent: (h.textContent ?? '').trim().substring(0, 200),
      childCount: h.children.length,
    }
  })
}

/** Find the region whose bounds contain the given element bounds */
function findContainingRegion(
  regions: Record<string, Region>,
  bounds: { x: number; y: number; width: number; height: number },
): [string, Region] | null {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2

  for (const [key, region] of Object.entries(regions)) {
    const rb = region.bounds
    if (cx >= rb.x && cx <= rb.x + rb.width && cy >= rb.y && cy <= rb.y + rb.height) {
      return [key, region]
    }
  }
  return null
}

function buildRegionKey(role: string, name: string): string {
  if (name && name !== role) {
    return `${role}-${slugify(name)}`
  }
  return role
}

function inferTheme(bg: string): string {
  const match = bg.match(/\d+/g)
  if (!match) return 'unknown'
  const avg = match.slice(0, 3).reduce((sum, v) => sum + Number(v), 0) / 3
  return avg < 128 ? 'dark' : 'light'
}

function inferLayout(regions: Record<string, Region>): string {
  const parts: string[] = []
  const keys = Object.keys(regions)
  if (keys.some(k => k.startsWith('banner'))) parts.push('header')
  if (keys.some(k => k.startsWith('navigation'))) parts.push('sidebar')
  if (keys.some(k => k.startsWith('main'))) parts.push('main')
  if (keys.some(k => k.startsWith('complementary'))) parts.push('aside')
  if (keys.some(k => k.startsWith('contentinfo'))) parts.push('footer')
  return parts.join(' + ')
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30)
}
