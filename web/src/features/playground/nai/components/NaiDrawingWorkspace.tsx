/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { ImageAdd01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

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
} from '@/features/gallery/components/canvas-node-deletion'
import { useCanvasRoute } from '@/features/gallery/hooks/use-canvas-route'
import { exportCanvasProject } from '@/features/gallery/lib/canvas-projects'
import { CanvasToolbar } from '@/features/playground/drawing/components/CanvasToolbar'
import { CanvasViewportControls } from '@/features/playground/drawing/components/CanvasViewportControls'
import { downloadBlob } from '@/features/playground/drawing/lib/image-assets'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useAuthStore } from '@/stores/auth-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { useNaiDrawingPersistenceStatus } from '../hooks/use-nai-drawing-persistence'
import { useNaiImageGeneration } from '../hooks/use-nai-image-generation'
import type { NaiCanvasNode } from '../types'
import { NaiImageCanvasNode } from './NaiImageCanvasNode'
import { NaiImagePreview } from './NaiImagePreview'
import { NaiSettings } from './NaiSettings'

const nodeTypes = { 'nai-image': NaiImageCanvasNode }

export function NaiDrawing(
  props: { canvasId?: string; focusAssetId?: string } = {}
) {
  const userId = useAuthStore((state) => state.auth.user?.id)
  if (!userId) return null
  return (
    <ReactFlowProvider key={userId}>
      <NaiDrawingEntry userId={userId} {...props} />
    </ReactFlowProvider>
  )
}

function NaiDrawingEntry(props: {
  userId: number
  canvasId?: string
  focusAssetId?: string
}) {
  const { t } = useTranslation()
  const error = useCanvasRoute('nai', props.canvasId, props.focusAssetId)
  return (
    <>
      {error ? (
        <Alert variant='destructive'>
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      ) : null}
      <NaiDrawingWorkspace userId={props.userId} />
    </>
  )
}

function NaiDrawingWorkspace(props: { userId: number }) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const flow = useReactFlow<NaiCanvasNode>()
  const deletion = useCanvasNodeDeletion('nai')
  const compact = useMediaQuery('(max-width: 1023px)')
  const canvas = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<'select' | 'hand'>('select')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const status = useNaiDrawingPersistenceStatus()
  const nodes = useNaiDrawingStore((state) => state.nodes)
  const canUndo = useNaiDrawingStore((state) => state.past.length > 0)
  const canRedo = useNaiDrawingStore((state) => state.future.length > 0)
  const viewport = useNaiDrawingStore((state) => state.viewport)
  const changeNodes = useNaiDrawingStore((state) => state.changeNodes)
  const checkpoint = useNaiDrawingStore((state) => state.checkpoint)
  const setViewport = useNaiDrawingStore((state) => state.setViewport)
  const { generate, cancel, pendingCount } = useNaiImageGeneration()
  const settings = useNaiDrawingStore((state) => state.settings)

  const insertionPoint = () => {
    const rect = canvas.current?.getBoundingClientRect()
    if (!rect) return
    return flow.screenToFlowPosition({ x: rect.x + 180, y: rect.y + 70 })
  }

  const submit = () => {
    const accepted = generate(settings)
    if (!accepted) return
    setSettingsOpen(false)
    const point = insertionPoint()
    if (point) {
      requestAnimationFrame(() => {
        void flow.fitView({ padding: 0.3, maxZoom: 1 })
      })
    }
  }

  if (status === 'loading' && !useNaiDrawingStore.getState().ready) {
    return (
      <div className='text-muted-foreground flex min-h-0 flex-1 items-center justify-center gap-2 text-sm'>
        <Spinner />
        {t('Loading NAI canvas…')}
      </div>
    )
  }

  const settingsPanel = (
    <NaiSettings
      userId={props.userId}
      onGenerate={submit}
      pendingCount={pendingCount}
      onCancel={cancel}
    />
  )

  return (
    <section
      className='flex min-h-0 flex-1 flex-col overflow-hidden'
      aria-label={t('NAI drawing canvas')}
    >
      <CanvasEditorHeader
        kind='nai'
        toolbarLabel={t('NAI canvas tools')}
        statusDetail={
          <span className='text-muted-foreground max-w-40 truncate text-xs'>
            {status === 'saving'
              ? t('Saving…')
              : t('NAI image nodes: {{count}}', { count: nodes.length })}
          </span>
        }
      >
        <CanvasToolbar
          tool={tool}
          onToolChange={setTool}
          compact={compact}
          canUndo={canUndo}
          canRedo={canRedo}
          count={nodes.length}
          onUndo={() => useNaiDrawingStore.getState().undo()}
          onRedo={() => useNaiDrawingStore.getState().redo()}
          onSettings={() => setSettingsOpen(true)}
          onArrange={() => {
            useNaiDrawingStore.getState().arrange()
            requestAnimationFrame(
              () => void flow.fitView({ padding: 0.2, maxZoom: 1 })
            )
          }}
          onExport={() => {
            const auth = useAuthStore.getState().auth
            void exportCanvasProject(
              {
                userId: auth.user?.id ?? null,
                sessionId: auth.session?.sid ?? null,
              },
              'nai'
            )
              .then((blob) => downloadBlob(blob, 'nai-canvas.json'))
              .catch(() => toast.error(t('The canvas could not be exported.')))
          }}
        />
      </CanvasEditorHeader>
      {status === 'error' && (
        <Alert
          variant='destructive'
          className='shrink-0 rounded-none border-x-0 border-t-0 py-2'
        >
          <AlertDescription>
            {t(
              'NAI canvas storage is unavailable. Export your current work before leaving.'
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className='flex min-h-0 flex-1 overflow-hidden'>
        {!compact && (
          <aside
            className='bg-background h-full w-80 shrink-0 overflow-hidden border-r'
            aria-label={t('NAI generation settings')}
          >
            {settingsPanel}
          </aside>
        )}
        <div
          ref={canvas}
          className='relative min-h-0 min-w-0 flex-1 outline-none'
          tabIndex={0}
          aria-label={t('NAI image canvas')}
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
              if (event.shiftKey) useNaiDrawingStore.getState().redo()
              else useNaiDrawingStore.getState().undo()
            } else if (command && event.key.toLowerCase() === 'y') {
              event.preventDefault()
              useNaiDrawingStore.getState().redo()
            } else if (!command && event.key.toLowerCase() === 'h') {
              setTool('hand')
            } else if (!command && event.key.toLowerCase() === 'v') {
              setTool('select')
            }
          }}
        >
          <CanvasNodeDeletionContext value={deletion.request}>
            <ReactFlow<NaiCanvasNode>
              nodes={nodes}
              edges={[]}
              nodeTypes={nodeTypes}
              defaultViewport={viewport}
              colorMode={resolvedTheme}
              onNodesChange={changeNodes}
              onBeforeDelete={async ({ nodes }) => {
                if (!nodes.length) return true
                deletion.request(nodes.map((node) => node.id))
                return false
              }}
              onNodeDragStart={checkpoint}
              onMoveEnd={(_event, nextViewport) => setViewport(nextViewport)}
              nodesConnectable={false}
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
                  'Press Enter to select an NAI image and use arrow keys to move it. Delete removes the selection.'
                ),
                'minimap.ariaLabel': t('NAI canvas overview'),
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
                  nodeColor='var(--primary)'
                  maskColor='color-mix(in srgb, var(--background) 65%, transparent)'
                />
              )}
            </ReactFlow>
          </CanvasNodeDeletionContext>
          {deletion.dialog}
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
                    {t('Start creating NAI images')}
                  </EmptyTitle>
                  <EmptyDescription>
                    {t(
                      'Generate images with NovelAI, then arrange and refine them on your canvas.'
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
                      {t('Generate NAI images')}
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
        </div>
      </div>
      {compact && (
        <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
          <SheetContent side='left' className='w-full gap-0 p-0 sm:max-w-sm'>
            <SheetHeader className='sr-only'>
              <SheetTitle>{t('NAI generation settings')}</SheetTitle>
              <SheetDescription>
                {t('Configure and generate NovelAI images.')}
              </SheetDescription>
            </SheetHeader>
            {settingsPanel}
          </SheetContent>
        </Sheet>
      )}
      <NaiImagePreview />
    </section>
  )
}
