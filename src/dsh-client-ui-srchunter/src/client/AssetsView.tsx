/**
 * AssetsView: the 资产 sub-tab of the 漏洞挖掘 view, with a 列表/图 mode toggle.
 * List mode groups assets by type (root domain → subdomain → ip → service →
 * app → endpoint) and shows each parent link inline; graph mode renders the
 * parent-child asset tree with @xyflow/react (positions from the pure
 * `layoutAssets` helper).
 */

import { useMemo, useState } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  type EdgeProps,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { SrchunterAssetType, SrchunterProjection } from '@deepseek-ai/dsh-srchunter/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ASSET_NODE_SIZE, layoutAssets, type AssetGraphNode } from './graph.ts'
import { GraphDetailDrawer } from './GraphDetailDrawer.tsx'
import type { SrchunterKey } from './locales.ts'
import css from './AssetsView.module.css'

/** Asset type label keys, in display order. */
const ASSET_TYPES = ['root-domain', 'subdomain', 'ip', 'service', 'app', 'endpoint'] as const satisfies readonly SrchunterAssetType[]

/** Asset type badge label keys. */
const TYPE_LABELS: Record<SrchunterAssetType, SrchunterKey> = {
  'root-domain': 'asset.type.root-domain',
  'subdomain': 'asset.type.subdomain',
  'ip': 'asset.type.ip',
  'service': 'asset.type.service',
  'app': 'asset.type.app',
  'endpoint': 'asset.type.endpoint',
}

/** The two view modes of the assets tab. */
type AssetMode = 'list' | 'graph'

/** One asset row in list mode (with the parent value resolved). */
interface AssetRow {
  readonly id: string
  readonly type: SrchunterAssetType
  readonly value: string
  readonly meta: string
  readonly owner: string
  readonly parentValue: string
}

/** Resolve the parent value of every asset from the parent edges. */
function rowsOf(projection: SrchunterProjection): AssetRow[] {
  return projection.assets.map((asset) => {
    const parentEdge = projection.edges.find(edge => edge.kind === 'parent' && edge.targetId === asset.id)
    const parent = parentEdge === undefined
      ? undefined
      : projection.assets.find(candidate => candidate.id === parentEdge.sourceId)
    return {
      id: asset.id,
      type: asset.type,
      value: asset.value,
      meta: asset.meta,
      owner: asset.owner,
      parentValue: parent?.value ?? '',
    }
  })
}

/** Group asset rows by type in display order. */
function groupByType(rows: readonly AssetRow[]): Array<{ type: SrchunterAssetType; rows: AssetRow[] }> {
  return ASSET_TYPES
    .map(type => ({ type, rows: rows.filter(row => row.type === type) }))
    .filter(group => group.rows.length > 0)
}

/** List mode: sections per asset type with inline parent links. */
function AssetList({ srchunter, t, query }: AssetsViewProps & { readonly query: string }) {
  const needle = query.trim().toLowerCase()
  const groups = groupByType(rowsOf(srchunter))
    .map(group => ({
      type: group.type,
      rows: needle === ''
        ? group.rows
        : group.rows.filter(row => `${row.value} ${row.meta} ${row.owner} ${row.parentValue}`.toLowerCase().includes(needle)),
    }))
    .filter(group => group.rows.length > 0)
  if (groups.length === 0) {
    return <p className={css.empty} data-testid="srchunter-assets-filtered-empty">{t('assets.filter.none')}</p>
  }
  return (
    <div className={css.list} data-testid="srchunter-assets-list">
      {groups.map(group => (
        <section key={group.type} className={css.group} data-testid="srchunter-asset-group">
          <h4 className={css.groupTitle}>
            {t(TYPE_LABELS[group.type])}
            <span className={css.groupCount}>{group.rows.length}</span>
          </h4>
          <ul className={css.rows}>
            {group.rows.map(row => (
              <li key={row.id} className={css.row} data-testid="srchunter-asset-row">
                <span className={css.rowValue}>{row.value}</span>
                {row.meta !== '' && <span className={css.rowMeta}>（{row.meta}）</span>}
                {row.owner !== '' && <span className={css.rowParent} data-testid="srchunter-asset-owner">{t('asset.owner')}: {row.owner}</span>}
                {row.parentValue !== '' && <span className={css.rowParent}>← {row.parentValue}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The React Flow node payload of one placed asset (type alias: the node data must satisfy Record<string, unknown>). */
type FlowNodeData = { readonly asset: AssetGraphNode }

/** One custom flow node: an asset-type badge over the value, with source/target handles. */
function AssetFlowNode({ data, t }: NodeProps & { t: PropsLocale<'srchunter'>['t'] }) {
  const asset = (data as FlowNodeData).asset
  return (
    <div className={css.node} data-type={asset.type} data-testid="explore-node-asset">
      <Handle type="target" position={Position.Left} className={css.handle} />
      <span className={css.nodeBadge}>{t(TYPE_LABELS[asset.type])}</span>
      <span className={css.nodeValue} title={asset.value}>{asset.value}</span>
      {asset.meta !== '' && <span className={css.nodeMeta} title={asset.meta}>{asset.meta}</span>}
      {asset.owner !== '' && <span className={css.nodeMeta} title={asset.owner}>{asset.owner}</span>}
      <Handle type="source" position={Position.Right} className={css.handle} />
    </div>
  )
}

/** One custom edge: a bezier curve with a visible 隶属 pill at its midpoint. */
export function AssetEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetPosition, targetX, targetY })
  return (
    <>
      <BaseEdge id={id} path={path} />
      {label !== undefined && (
        <EdgeLabelRenderer>
          <div className={css.edgeLabel} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** Graph mode: the parent-child asset tree. */
function AssetGraph({ srchunter, t }: AssetsViewProps) {
  const { nodes, edges } = useMemo(() => layoutAssets(srchunter), [srchunter])
  const [selectedAsset, setSelectedAsset] = useState<AssetGraphNode | null>(null)
  const flowNodes = useMemo<FlowNode<FlowNodeData, 'srchunter'>[]>(() =>
    nodes.map(node => ({
      id: node.id,
      type: 'srchunter',
      position: { x: node.x, y: node.y },
      data: { asset: node },
      style: ASSET_NODE_SIZE,
    })), [nodes])
  const flowEdges = useMemo<FlowEdge[]>(() =>
    edges.map(edge => ({
      id: edge.id,
      type: 'srchunter',
      source: edge.sourceId,
      target: edge.targetId,
      label: t('edge.parent'),
    })), [edges, t])
  const nodeTypes = useMemo<NodeTypes>(() => ({
    srchunter: (props: NodeProps) => <AssetFlowNode {...props} t={t} />,
  }), [t])
  return (
    <div className={css.graph} data-testid="srchunter-assets-graph">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={{ srchunter: AssetEdge }}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        onPaneClick={() => { setSelectedAsset(null) }}
        onNodeClick={(_, flowNode) => { setSelectedAsset((flowNode.data as FlowNodeData).asset) }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      {selectedAsset !== null && (
        <GraphDetailDrawer
          title={selectedAsset.value}
          fields={[
            { label: t('field.assetType'), value: t(TYPE_LABELS[selectedAsset.type]) },
            { label: t('field.assetValue'), value: selectedAsset.value },
            { label: t('field.meta'), value: selectedAsset.meta },
            { label: t('asset.owner'), value: selectedAsset.owner },
          ]}
          onClose={() => { setSelectedAsset(null) }}
        />
      )}
    </div>
  )
}

/** Full props of the assets sub-tab. */
export interface AssetsViewProps {
  readonly srchunter: SrchunterProjection
  readonly t: PropsLocale<'srchunter'>['t']
}

export function AssetsView({ srchunter, t }: AssetsViewProps) {
  const [mode, setMode] = useState<AssetMode>('list')
  const [query, setQuery] = useState('')
  if (srchunter.assets.length === 0) {
    return <p className={css.empty} data-testid="srchunter-assets-empty">{t('assets.empty')}</p>
  }
  return (
    <div className={css.root} data-testid="srchunter-assets">
      <div className={css.modeBar}>
        <div className={css.modes}>
          {(['list', 'graph'] as const).map(modeKey => (
            <button
              key={modeKey}
              type="button"
              className={css.modeButton}
              aria-pressed={mode === modeKey}
              data-testid={`srchunter-assets-mode-${modeKey}`}
              onClick={() => { setMode(modeKey) }}
            >
              {t(modeKey === 'list' ? 'assets.mode.list' : 'assets.mode.graph')}
            </button>
          ))}
        </div>
        {mode === 'list' && (
          <input
            type="search"
            className={css.search}
            placeholder={t('assets.filter')}
            aria-label={t('assets.filter')}
            value={query}
            data-testid="srchunter-assets-search"
            onChange={event => { setQuery(event.target.value) }}
          />
        )}
      </div>
      {mode === 'list'
        ? <AssetList srchunter={srchunter} t={t} query={query} />
        : <AssetGraph srchunter={srchunter} t={t} />}
    </div>
  )
}
