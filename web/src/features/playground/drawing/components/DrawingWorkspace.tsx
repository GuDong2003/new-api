/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { Delete02Icon, ImageAdd01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useTheme } from '@/context/theme-provider'
import { CanvasEditorHeader } from '@/features/gallery/components/canvas-editor-header'
import {
  CanvasNodeDeletionContext,
  useCanvasNodeDeletion,
  deleteCanvasNodes,
  captureCanvasTarget,
  assertCanvasTarget,
} from '@/features/gallery/components/canvas-node-deletion'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useDrawingStore } from '@/stores/drawing-store'

import { ImageRetryContext } from '../context/image-retry-context'
import { useCanvasFiles } from '../hooks/use-canvas-files'
import { useDrawingPersistenceStatus } from '../hooks/use-drawing-persistence'
import { useImageGeneration } from '../hooks/use-image-generation'
import { useReferenceConnections } from '../hooks/use-reference-connections'
import { imageFileToAsset } from '../lib/image-assets'
import { canConnectReference } from '../lib/reference-connections'
import type { DrawingNode, ImageSettings } from '../types'
import { CanvasToolbar } from './CanvasToolbar'
import { CanvasViewportControls } from './CanvasViewportControls'
import { DrawingSettings } from './DrawingSettings'
import { ImageCanvasNode } from './ImageCanvasNode'
import { ImagePreview } from './ImagePreview'
import { MaskEditor } from './MaskEditor'

import '@xyflow/react/dist/style.css'

const nodeTypes = { image: ImageCanvasNode }
const defaultEdgeOptions = {
  type: 'smoothstep',
  style: { stroke: 'var(--primary)', opacity: 0.7, strokeWidth: 2 },
  markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--primary)' },
}

export function DrawingWorkspace(props: { userId: number }) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const flow = useReactFlow<DrawingNode>()
  const deletion = useCanvasNodeDeletion('drawing')
  const saveStatus = useDrawingPersistenceStatus()
  const ready = useDrawingStore(
    (state) => state.ready && state.userId === props.userId
  )
  const nodes = useDrawingStore((state) => state.nodes)
  const edges = useDrawingStore((state) => state.edges)
  const selectedEdges = edges.filter((edge) => edge.selected)
  const selectedReferencesPending = selectedEdges.some((edge) =>
    nodes.some(
      (node) => node.id === edge.target && node.data.status === 'pending'
    )
  )
  const canvasEdges = useMemo(
    () =>
      edges.map((edge) =>
        edge.selected
          ? {
              ...edge,
              style: {
                ...defaultEdgeOptions.style,
                ...edge.style,
                strokeWidth: 3,
                opacity: 1,
              },
            }
          : edge
      ),
    [edges]
  )
  const viewport = useDrawingStore((state) => state.viewport)
  const referenceId = useDrawingStore((state) => state.referenceIds[0])
  const changeNodes = useDrawingStore((state) => state.changeNodes)
  const changeEdges = useDrawingStore((state) => state.changeEdges)
  const referenceConnections = useReferenceConnections()
  const checkpoint = useDrawingStore((state) => state.checkpoint)
  const setViewport = useDrawingStore((state) => state.setViewport)
  const { generate, retry, cancel, pendingCount } = useImageGeneration()
  const files = useCanvasFiles()
  const compact = useMediaQuery('(max-width: 1023px)')
  const canvas = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<'select' | 'hand'>('select')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const clearTarget = useRef<ReturnType<typeof captureCanvasTarget> | null>(
    null
  )
  const [replacing, setReplacing] = useState(false)
  const [replaceError, setReplaceError] = useState<string | null>(null)
  const [maskEditorOpen, setMaskEditorOpen] = useState(false)
  const maskState = useDrawingStore((state) => state.mask)
  const setMaskState = useDrawingStore((state) => state.setMask)
  const reference = nodes.find((node) => node.id === referenceId)?.data.asset
  const mask =
    maskState && maskState.referenceId === referenceId
      ? maskState.asset
      : undefined

  const insertionPoint = () => {
    const rect = canvas.current?.getBoundingClientRect()
    if (!rect) return { x: 40, y: 40 }
    return flow.screenToFlowPosition({
      x: rect.x + Math.min(rect.width / 3, 180),
      y: rect.y + 70,
    })
  }
  const submit = (settings: ImageSettings) => {
    if (!generate(settings, insertionPoint(), mask)) return
    setSettingsOpen(false)
    const newNodes = useDrawingStore.getState().nodes.slice(-settings.n)
    requestAnimationFrame(() => {
      void flow.fitView({ nodes: newNodes, padding: 0.3, maxZoom: 1 })
    })
  }
  const settingsPanel = (
    <DrawingSettings
      userId={props.userId}
      pendingCount={pendingCount}
      onGenerate={submit}
      onCancel={() => cancel()}
      onUploadReferences={(uploaded) => {
        void files.addImages(uploaded, insertionPoint(), true)
      }}
      mask={mask}
      onClearMask={() => setMaskState(null)}
      onDrawMask={() => setMaskEditorOpen(true)}
      onMaskUpload={async (file) => {
        const target = captureCanvasTarget('drawing')
        try {
          const asset = await imageFileToAsset(file)
          assertCanvasTarget('drawing', target)
          if (useDrawingStore.getState().referenceIds[0] !== referenceId) {
            throw new Error('The canvas changed. Please try again.')
          }
          if (
            !reference ||
            asset.mimeType !== 'image/png' ||
            asset.width !== reference.width ||
            asset.height !== reference.height
          ) {
            toast.error(
              t(
                'The mask must be a PNG with the same dimensions as the first reference image.'
              )
            )
            return
          }
          setMaskState({ referenceId, asset })
        } catch (error) {
          toast.error(
            t(
              error instanceof Error
                ? error.message
                : 'The image could not be loaded.'
            )
          )
        }
      }}
    />
  )

  if (!ready && saveStatus === 'error') {
    return (
      <section className='flex min-h-0 flex-1 flex-col'>
        <CanvasEditorHeader kind='drawing' />
        <Alert variant='destructive'>
          <AlertDescription>
            {t(
              'Canvas storage is unavailable. Export your canvas to keep a copy.'
            )}
          </AlertDescription>
        </Alert>
      </section>
    )
  }
  if (!ready) {
    return (
      <div
        className='text-muted-foreground flex min-h-0 flex-1 items-center justify-center gap-2 text-sm'
        role='status'
      >
        <Spinner />
        {t('Loading canvas…')}
      </div>
    )
  }
  return (
    <section
      className='flex min-h-0 flex-1 flex-col overflow-hidden'
      aria-label={t('Drawing playground')}
    >
      <CanvasEditorHeader kind='drawing' />
      <CanvasToolbar
        tool={tool}
        onToolChange={(nextTool) => {
          referenceConnections.cancel()
          setTool(nextTool)
        }}
        compact={compact}
        saveStatus={saveStatus}
        busy={files.busy}
        onUpload={(uploaded) => {
          void files.addImages(uploaded, insertionPoint())
        }}
        onImport={(file) => {
          void files.importCanvas(file)
        }}
        onExport={files.exportCanvas}
        onClear={() => {
          clearTarget.current = captureCanvasTarget('drawing')
          setReplaceError(null)
          setClearOpen(true)
        }}
        onSettings={() => setSettingsOpen(true)}
        onArrange={() => {
          useDrawingStore.getState().arrange()
          requestAnimationFrame(() => {
            void flow.fitView({ padding: 0.2, maxZoom: 1 })
          })
        }}
      />
      {saveStatus === 'error' && (
        <Alert
          variant='destructive'
          className='shrink-0 rounded-none border-x-0 border-t-0 py-2'
        >
          <AlertDescription>
            {t(
              'Canvas storage is unavailable. Export your canvas to keep a copy.'
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className='flex min-h-0 flex-1 overflow-hidden'>
        {!compact && (
          <aside
            className='bg-background h-full w-80 shrink-0 overflow-hidden border-r'
            aria-label={t('Image generation settings')}
          >
            {settingsPanel}
          </aside>
        )}
        <div
          ref={canvas}
          className='relative min-h-0 min-w-0 flex-1 outline-none'
          tabIndex={0}
          aria-label={t('Image canvas')}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }
          }}
          onDrop={(event) => {
            event.preventDefault()
            void files.addImages(
              [...event.dataTransfer.files],
              flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
            )
          }}
          onPaste={(event) => {
            if (
              (event.target as HTMLElement).closest(
                'input, textarea, [contenteditable=true]'
              )
            ) {
              return
            }
            const images = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith('image/')
            )
            if (images.length) {
              event.preventDefault()
              void files.addImages(images, insertionPoint())
            }
          }}
          onKeyDown={(event) => {
            if (
              (event.target as HTMLElement).closest(
                'input, textarea, select, button, [contenteditable=true]'
              )
            ) {
              return
            }
            const command = event.ctrlKey || event.metaKey
            if (command && event.key.toLowerCase() === 'z') {
              event.preventDefault()
              if (event.shiftKey) useDrawingStore.getState().redo()
              else useDrawingStore.getState().undo()
            } else if (command && event.key.toLowerCase() === 'y') {
              event.preventDefault()
              useDrawingStore.getState().redo()
            } else if (command && event.key.toLowerCase() === 'a') {
              event.preventDefault()
              changeNodes(
                nodes.map((node) => ({
                  type: 'select',
                  id: node.id,
                  selected: true,
                }))
              )
            } else if (!command && event.key.toLowerCase() === 'h') {
              referenceConnections.cancel()
              setTool('hand')
            } else if (!command && event.key.toLowerCase() === 'v') {
              referenceConnections.cancel()
              setTool('select')
            }
          }}
        >
          <CanvasNodeDeletionContext value={deletion.request}>
            <ImageRetryContext value={retry}>
              <ReactFlow<DrawingNode>
                nodes={nodes}
                edges={canvasEdges}
                nodeTypes={nodeTypes}
                defaultViewport={viewport}
                colorMode={resolvedTheme}
                onNodesChange={changeNodes}
                onBeforeDelete={async ({ nodes }) => {
                  if (!nodes.length) return true
                  deletion.request(nodes.map((node) => node.id))
                  return false
                }}
                onEdgesChange={changeEdges}
                onConnect={referenceConnections.onConnect}
                onConnectStart={referenceConnections.onConnectStart}
                isValidConnection={(connection) =>
                  canConnectReference(
                    useDrawingStore.getState().nodes,
                    connection
                  )
                }
                onNodeDragStart={checkpoint}
                onMoveEnd={(_event, nextViewport) => setViewport(nextViewport)}
                defaultEdgeOptions={defaultEdgeOptions}
                nodesConnectable={tool === 'select'}
                edgesReconnectable={false}
                selectionOnDrag={tool === 'select'}
                panOnDrag={tool === 'hand' ? [0, 1, 2] : [1, 2]}
                panActivationKeyCode='Space'
                zoomOnDoubleClick={false}
                minZoom={0.1}
                maxZoom={4}
                deleteKeyCode={['Delete', 'Backspace']}
                onlyRenderVisibleElements
                className='bg-muted/25'
                attributionPosition='bottom-right'
                ariaLabelConfig={{
                  'node.a11yDescription.default': t(
                    'Press Enter to select an image and use arrow keys to move it. Delete removes the selection.'
                  ),
                  'node.a11yDescription.keyboardDisabled': t(
                    'Press Enter to select an image.'
                  ),
                  'node.a11yDescription.ariaLiveMessage': ({ x, y }) =>
                    t('Image moved to {{x}}, {{y}}.', { x, y }),
                  'edge.a11yDescription.default': t('Reference connection'),
                  'handle.ariaLabel': t('Reference connection'),
                  'minimap.ariaLabel': t('Canvas overview'),
                }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={24}
                  size={1}
                  color='var(--border)'
                />
                <CanvasViewportControls />
                {!compact && nodes.length > 0 && (
                  <MiniMap
                    pannable
                    zoomable
                    position='bottom-right'
                    className='!bg-background !mb-8 !overflow-hidden !rounded-lg !border'
                    style={{ width: 144, height: 96 }}
                    nodeColor='var(--muted-foreground)'
                    maskColor='color-mix(in srgb, var(--background) 65%, transparent)'
                    maskStrokeColor='var(--primary)'
                    maskStrokeWidth={1}
                  />
                )}
              </ReactFlow>
            </ImageRetryContext>
          </CanvasNodeDeletionContext>
          {deletion.dialog}
          {selectedEdges.length > 0 && (
            <div className='absolute bottom-14 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2'>
              <Button
                type='button'
                variant='destructive'
                size='sm'
                className='min-h-10 shadow-sm'
                disabled={selectedReferencesPending}
                title={
                  selectedReferencesPending
                    ? t(
                        'Reference images cannot be changed while generation is running.'
                      )
                    : undefined
                }
                onClick={() =>
                  changeEdges(
                    selectedEdges.map((edge) => ({
                      type: 'remove',
                      id: edge.id,
                    }))
                  )
                }
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={16}
                  aria-hidden='true'
                />
                {t('Delete selected connections')}
              </Button>
              {selectedReferencesPending && (
                <p
                  className='bg-background/90 w-64 max-w-[calc(100vw-2rem)] rounded-md border p-2 text-center text-xs'
                  role='status'
                >
                  {t(
                    'Reference images cannot be changed while generation is running.'
                  )}
                </p>
              )}
            </div>
          )}
          {nodes.length === 0 && (
            <div className='pointer-events-none absolute inset-0 flex items-center justify-center p-6 pb-20'>
              <Empty className='max-w-md flex-initial'>
                <EmptyHeader>
                  <EmptyMedia
                    variant='icon'
                    className='bg-background size-12 rounded-2xl border shadow-sm'
                  >
                    <HugeiconsIcon
                      icon={ImageAdd01Icon}
                      size={24}
                      aria-hidden='true'
                    />
                  </EmptyMedia>
                  <EmptyTitle className='text-xl font-semibold tracking-tight'>
                    {t('Room for every idea')}
                  </EmptyTitle>
                  <EmptyDescription>
                    {t(
                      'Generate your first image, then move, compare and refine it here. Drop images onto the canvas to get started.'
                    )}
                  </EmptyDescription>
                </EmptyHeader>
                {compact && (
                  <EmptyContent>
                    <Button
                      type='button'
                      className='pointer-events-auto'
                      onClick={() => setSettingsOpen(true)}
                    >
                      {t('Create an image')}
                    </Button>
                  </EmptyContent>
                )}
                <p className='text-muted-foreground text-xs'>
                  {t(
                    'Scroll to zoom · Space + drag to pan · Shift + drag to select'
                  )}
                </p>
              </Empty>
            </div>
          )}
          {files.busy && (
            <div
              role='status'
              className='bg-background absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-sm'
            >
              <Spinner className='size-3' />
              {t('Importing…')}
            </div>
          )}
        </div>
      </div>
      {compact && (
        <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
          <SheetContent side='left' className='w-full gap-0 p-0 sm:max-w-sm'>
            <SheetHeader className='sr-only'>
              <SheetTitle>{t('Image generation settings')}</SheetTitle>
              <SheetDescription>
                {t('Configure and generate images.')}
              </SheetDescription>
            </SheetHeader>
            {settingsPanel}
          </SheetContent>
        </Sheet>
      )}
      <ConfirmDialog
        open={clearOpen || Boolean(files.pendingImport)}
        onOpenChange={(open) => {
          if (!open && !replacing) {
            setClearOpen(false)
            files.setPendingImport(null)
            setReplaceError(null)
          }
        }}
        title={files.pendingImport ? t('Import canvas') : t('Clear canvas')}
        desc={t(
          'This replaces the current canvas and deletes its shared images from the gallery. This cannot be undone.'
        )}
        destructive
        isLoading={replacing}
        confirmText={t('Confirm')}
        handleConfirm={() => {
          const target = files.pendingImport
            ? files.pendingImportTarget.current
            : clearTarget.current
          if (!target) return
          const imported = files.pendingImport
          setReplacing(true)
          setReplaceError(null)
          void (async () => {
            assertCanvasTarget('drawing', target)
            cancel()
            await deleteCanvasNodes(
              'drawing',
              useDrawingStore.getState().nodes.map((node) => node.id),
              target
            )
            assertCanvasTarget('drawing', target)
            if (imported) {
              // Imported resources are a deliberate new import, never resurrection
              // of the identifiers explicitly deleted from the replaced document.
              const ids = new Map<string, string>()
              const asset = (
                value: NonNullable<DrawingNode['data']['asset']>
              ) => {
                const id = ids.get(value.id) ?? crypto.randomUUID()
                ids.set(value.id, id)
                return { ...value, id }
              }
              const document = {
                ...imported,
                nodes: imported.nodes.map((node) => ({
                  ...node,
                  data: {
                    ...node.data,
                    ...(node.data.asset
                      ? { asset: asset(node.data.asset) }
                      : {}),
                    ...(node.data.mask ? { mask: asset(node.data.mask) } : {}),
                  },
                })),
                mask: imported.mask
                  ? { ...imported.mask, asset: asset(imported.mask.asset) }
                  : null,
              }
              useDrawingStore.getState().replaceDocument(document)
              useDrawingStore.setState({
                assetRoles: Object.fromEntries(
                  document.nodes.flatMap((node) =>
                    node.data.asset
                      ? [
                          [
                            node.data.asset.id,
                            { role: 'reference' as const, nodeId: node.id },
                          ],
                        ]
                      : []
                  )
                ),
                past: [],
                future: [],
              })
              void flow.setViewport(document.viewport)
            } else {
              useDrawingStore.getState().clear()
              useDrawingStore.setState({ past: [], future: [] })
            }
            setClearOpen(false)
            files.setPendingImport(null)
          })()
            .catch((error: unknown) =>
              setReplaceError(
                error instanceof Error ? error.message : 'Request failed'
              )
            )
            .finally(() => setReplacing(false))
        }}
      >
        {replaceError ? <p role='alert'>{t(replaceError)}</p> : null}
      </ConfirmDialog>
      {maskEditorOpen && reference && (
        <MaskEditor
          image={reference}
          onClose={() => setMaskEditorOpen(false)}
          onSave={(asset) => {
            setMaskState({ referenceId, asset })
            setMaskEditorOpen(false)
          }}
        />
      )}
      <ImagePreview />
    </section>
  )
}
