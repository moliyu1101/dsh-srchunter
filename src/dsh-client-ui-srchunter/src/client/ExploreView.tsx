/**
 * ExploreView: the 探索链路 sub-tab of the 漏洞挖掘 view. Renders the
 * exploration chain (goal → intent → fact → derived intent → finding) as an
 * interactive graph with @xyflow/react; positions come from the pure
 * `layoutExploration` helper, nodes carry kind badges and connection handles,
 * and a custom edge renders a visible relationship pill on every chain edge
 * (意图链 / 产出 / 推导自 / 证实).
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
import type { SrchunterIntentStatus, SrchunterProjection, SrchunterEdgeKind, SrchunterSeverity } from '@deepseek-ai/dsh-srchunter/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { EXPLORE_NODE_SIZE, layoutExploration, type ExploreGraphNode } from './graph.ts'
import { GraphDetailDrawer } from './GraphDetailDrawer.tsx'
import type { SrchunterKey } from './locales.ts'
import css from './ExploreView.module.css'

/** Kind badge label keys per node kind. */
const KIND_LABELS: Record<ExploreGraphNode['kind'], SrchunterKey> = {
  goal: 'kind.goal',
  intent: 'kind.intent',
  fact: 'kind.fact',
  finding: 'kind.finding',
}

/** The legend kinds, in chain order. */
const KINDS = ['goal', 'intent', 'fact', 'finding'] as const satisfies readonly ExploreGraphNode['kind'][]

/** The intent verdicts the chain badge can show. */
const STATUS_LABELS: Record<SrchunterIntentStatus, SrchunterKey> = {
  open: 'intent.status.open',
  working: 'intent.status.working',
  done: 'intent.status.done',
  deepen: 'intent.status.deepen',
  blocked: 'intent.status.blocked',
  dead_end: 'intent.status.dead_end',
}

/** Relationship label keys per chain edge kind (parent edges never reach this view). */
const EDGE_LABELS: Record<SrchunterEdgeKind, SrchunterKey> = {
  spawns: 'edge.spawns',
  yields: 'edge.yields',
  derived_from: 'edge.derived_from',
  proves: 'edge.proves',
  parent: 'edge.parent',
}

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<SrchunterSeverity, SrchunterKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** The React Flow node payload of one placed chain node (type alias: the node data must satisfy Record<string, unknown>). */
type FlowNodeData = { readonly node: ExploreGraphNode }

/** One custom flow node: a kind badge over the title and detail line, with source/target handles. */
function ChainNode({ data, t }: NodeProps & { t: PropsLocale<'srchunter'>['t'] }) {
  const node = (data as FlowNodeData).node
  return (
    <div className={css.node} data-kind={node.kind} data-severity={node.severity} data-testid={`explore-node-${node.kind}`}>
      <Handle type="target" position={Position.Left} className={css.handle} />
      <span className={css.badge}>{t(KIND_LABELS[node.kind])}</span>
      {node.status !== undefined && (
        <span className={css.badge} data-status={node.status} data-testid="explore-intent-status">
          {t(STATUS_LABELS[node.status])}
        </span>
      )}
      <span className={css.title} title={node.title}>{node.title}</span>
      {node.detail !== '' && <span className={css.detail} title={node.detail}>{node.detail}</span>}
      {node.severity !== undefined && (
        <span className={css.severity} data-severity={node.severity}>{t(SEVERITY_LABELS[node.severity])}</span>
      )}
      <Handle type="source" position={Position.Right} className={css.handle} />
    </div>
  )
}

/** One custom edge: a bezier curve with a visible relationship pill at its midpoint. */
export function ChainEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label }: EdgeProps) {
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

/** Full props of the explore sub-tab. */
export interface ExploreViewProps {
  readonly srchunter: SrchunterProjection
  readonly t: PropsLocale<'srchunter'>['t']
}

export function ExploreView({ srchunter, t }: ExploreViewProps) {
  const { nodes, edges } = useMemo(() => layoutExploration(srchunter), [srchunter])
  const [selectedNode, setSelectedNode] = useState<ExploreGraphNode | null>(null)
  const flowNodes = useMemo<FlowNode<FlowNodeData, 'srchunter'>[]>(() =>
    nodes.map(node => ({
      id: node.id,
      type: 'srchunter',
      position: { x: node.x, y: node.y },
      data: { node },
      style: EXPLORE_NODE_SIZE,
    })), [nodes])
  const flowEdges = useMemo<FlowEdge[]>(() =>
    edges.map(edge => ({
      id: edge.id,
      type: 'srchunter',
      source: edge.sourceId,
      target: edge.targetId,
      label: t(EDGE_LABELS[edge.kind]),
    })), [edges, t])
  // The locale seat rides into the custom nodes through a render-scoped type
  // map (React Flow re-renders nodes when the map identity changes).
  const nodeTypes = useMemo<NodeTypes>(() => ({
    srchunter: (props: NodeProps) => <ChainNode {...props} t={t} />,
  }), [t])
  const legend = KINDS.map(kind => ({
    kind,
    count: nodes.filter(node => node.kind === kind).length,
  })).filter(entry => entry.count > 0)
  return (
    <div className={css.graph} data-testid="srchunter-explore">
      {nodes.length <= 1 ? (
        <p className={css.empty} data-testid="srchunter-explore-empty">{t('explore.empty')}</p>
      ) : (
        <>
          <div className={css.legend} aria-label={t('explore.legend')} data-testid="srchunter-explore-legend">
            {legend.map(entry => (
              <span key={entry.kind} className={css.legendItem} data-kind={entry.kind}>
                {t(KIND_LABELS[entry.kind])}
                <b className={css.legendCount}>{entry.count}</b>
              </span>
            ))}
            <span className={css.legendHint}>{t('explore.hint')}</span>
          </div>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={{ srchunter: ChainEdge }}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            proOptions={{ hideAttribution: true }}
            onPaneClick={() => { setSelectedNode(null) }}
            onNodeClick={(_, flowNode) => { setSelectedNode((flowNode.data as FlowNodeData).node) }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </>
      )}
      {selectedNode !== null && (
        <GraphDetailDrawer
          title={selectedNode.title}
          fields={[
            { label: t('field.kind'), value: t(KIND_LABELS[selectedNode.kind]) },
            { label: t('field.detail'), value: selectedNode.detail },
            ...(selectedNode.status === undefined
              ? []
              : [{ label: t('intent.status'), value: t(STATUS_LABELS[selectedNode.status]) }]),
            { label: t('intent.disposition'), value: selectedNode.disposition },
            ...(selectedNode.severity === undefined ? [] : [{ label: t('field.severity'), value: t(SEVERITY_LABELS[selectedNode.severity]) }]),
          ]}
          onClose={() => { setSelectedNode(null) }}
        />
      )}
    </div>
  )
}
