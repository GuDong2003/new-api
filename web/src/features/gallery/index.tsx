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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuthStore } from '@/stores/auth-store'

import { deleteGalleryImage, getGalleryImages, listCanvasRecords } from './api'
import { CanvasCard, type CanvasProjectView } from './components/canvas-card'
import { CanvasProjectDialog } from './components/canvas-project-dialog'
import { CanvasSaveStatus } from './components/canvas-save-status'
import { CanvasSwitchDialog } from './components/canvas-switch-dialog'
import { GalleryImageCard } from './components/gallery-image-card'
import { GalleryPreview } from './components/gallery-preview'
import { GalleryUsageMeters } from './components/gallery-usage-meters'
import { useCanvasProjects } from './hooks/use-canvas-projects'
import { useGalleryGrid } from './hooks/use-gallery-grid'
import {
  canvasDeletionVersion,
  getCanvasDeletionEvents,
  subscribeCanvasDeletions,
} from './lib/canvas-events'
import { getUnsavedCanvasKind } from './lib/canvas-projects'
import { readCanvasAssets } from './lib/canvas-repository'
import { checkCanvasCapacity, getCanvasGalleryUsage } from './lib/canvas-sync'
import {
  collectGalleryPages,
  localGalleryImages,
  mergeGalleryImages,
} from './lib/gallery-collection'
import { removeGalleryThumbnail } from './lib/gallery-thumbnail-cache'
import { galleryOwner } from './lib/session'
import type {
  CanvasKind,
  CanvasSummary,
  GalleryIdentity,
  GalleryImage,
} from './types'

export { GallerySettingsSection } from './components/gallery-settings-section'

const galleryDeletionCursors = new Map<string, number>()
const galleryIdentityKey = (identity: GalleryIdentity) =>
  `${identity.userId}:${identity.sessionId}`

type PendingCanvasAction =
  | {
      type: 'open'
      id: string
      kind: CanvasKind
      image?: string
      sourceKind: CanvasKind
    }
  | { type: 'create'; name: string; kind: CanvasKind; sourceKind: CanvasKind }

export type GalleryView = 'images' | 'canvases'

export function Gallery(props: { initialView?: GalleryView } = {}) {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? null)
  if (userId === null || sessionId === null) {
    return <ErrorState description={t('Session expired!')} />
  }
  return (
    <GalleryContent
      key={`${userId}:${sessionId}`}
      identity={{ userId, sessionId }}
      initialView={props.initialView}
    />
  )
}

function GalleryContent(props: {
  identity: GalleryIdentity
  initialView?: GalleryView
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const identity = useMemo(
    () => ({
      userId: props.identity.userId,
      sessionId: props.identity.sessionId,
    }),
    [props.identity.sessionId, props.identity.userId]
  )
  const { gridRef, metrics } = useGalleryGrid()
  // Which tab opens is a route parameter so the canvas editor can link into
  // the list of canvases directly instead of landing on the images. Switching
  // afterwards stays local: it is not worth a history entry.
  const [view, setView] = useState<string>(props.initialView ?? 'images')
  const [source, setSource] = useState('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('newest')
  const [page, setPage] = useState(1)
  const [preview, setPreview] = useState<GalleryImage | null>(null)
  const [imageDeleteTarget, setImageDeleteTarget] =
    useState<GalleryImage | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CanvasProjectView | null>(
    null
  )
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null)
  const [renameTarget, setRenameTarget] = useState<CanvasProjectView | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingCanvasAction, setPendingCanvasAction] =
    useState<PendingCanvasAction | null>(null)
  const [removedImages, setRemovedImages] = useState<string[]>([])
  const [removedProjects, setRemovedProjects] = useState<string[]>([])
  const deletionVersion = useSyncExternalStore(
    subscribeCanvasDeletions,
    canvasDeletionVersion,
    canvasDeletionVersion
  )
  const deletionCursor =
    galleryDeletionCursors.get(galleryIdentityKey(props.identity)) ?? 0
  const deletionEvents = getCanvasDeletionEvents(props.identity, deletionCursor)
  const drawing = useCanvasProjects('drawing')
  const nai = useCanvasProjects('nai')
  const localProjects = useMemo(
    () => [...drawing.projects, ...nai.projects],
    [drawing.projects, nai.projects]
  )
  const key = ['gallery', props.identity.userId, props.identity.sessionId]
  const usage = useQuery({
    queryKey: [...key, 'usage'],
    queryFn: ({ signal }) => getCanvasGalleryUsage(props.identity, signal),
    retry: false,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  })
  const images = useQuery({
    queryKey: [...key, 'images'],
    queryFn: ({ signal }) =>
      collectGalleryPages((page) =>
        getGalleryImages(props.identity, page, undefined, signal)
      ),
    retry: false,
    enabled: view === 'images',
    staleTime: Infinity,
  })
  const canvases = useQuery({
    queryKey: [...key, 'canvases'],
    queryFn: ({ signal }) =>
      collectGalleryPages((page) =>
        listCanvasRecords(props.identity, { page }, signal)
      ),
    retry: false,
    enabled: view === 'canvases',
    staleTime: Infinity,
  })
  const canvasCount = useQuery({
    queryKey: [...key, 'canvas-count'],
    queryFn: ({ signal }) =>
      listCanvasRecords(props.identity, { page: 1, page_size: 1 }, signal),
    retry: false,
    staleTime: Infinity,
  })
  const local = useQuery({
    queryKey: [
      ...key,
      'local-assets',
      localProjects.map((item) => `${item.id}:${item.revision}`).join(','),
    ],
    queryFn: async () =>
      Promise.all(
        localProjects.map(async (canvas) => ({
          canvas,
          assets: await readCanvasAssets(
            galleryOwner(props.identity),
            canvas.id
          ),
        }))
      ),
    enabled: !drawing.loading && !nai.loading,
    retry: false,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  })
  useEffect(() => {
    const identityKey = galleryIdentityKey(identity)
    const cursor = galleryDeletionCursors.get(identityKey) ?? 0
    const events = getCanvasDeletionEvents(identity, cursor)
    if (!events.length) {
      galleryDeletionCursors.set(identityKey, deletionVersion)
      return
    }
    if (images.data === undefined && canvases.data === undefined) return
    let imagesChanged = false
    let canvasesChanged = false
    const imagesKey = ['gallery', identity.userId, identity.sessionId, 'images']
    const canvasesKey = [
      'gallery',
      identity.userId,
      identity.sessionId,
      'canvases',
    ]
    client.setQueryData<GalleryImage[]>(imagesKey, (current) => {
      if (!current) return current
      const next = current.filter(
        (image) =>
          !events.some(
            (event) =>
              event.assetId === image.id ||
              (!event.assetId && event.canvasId === image.canvas_id)
          )
      )
      imagesChanged = next.length !== current.length
      return next
    })
    client.setQueryData<CanvasSummary[]>(canvasesKey, (current) => {
      if (!current) return current
      const next = current.filter(
        (canvas) => !events.some((event) => event.canvasId === canvas.id)
      )
      canvasesChanged = next.length !== current.length
      return next
    })
    galleryDeletionCursors.set(
      identityKey,
      Math.max(deletionVersion, ...events.map((event) => event.version))
    )
    if (imagesChanged || canvasesChanged) {
      void Promise.all([
        client.invalidateQueries({
          queryKey: ['gallery', identity.userId, identity.sessionId, 'images'],
          refetchType: 'none',
        }),
        client.invalidateQueries({
          queryKey: [
            'gallery',
            identity.userId,
            identity.sessionId,
            'canvases',
          ],
          refetchType: 'none',
        }),
        client.invalidateQueries({
          queryKey: ['gallery', identity.userId, identity.sessionId, 'usage'],
        }),
        client.invalidateQueries({
          queryKey: [
            'gallery',
            identity.userId,
            identity.sessionId,
            'canvas-count',
          ],
        }),
      ])
    }
  }, [canvases.data, client, deletionVersion, images.data, identity])
  const hiddenProjects = new Set([
    ...removedProjects,
    ...drawing.pendingCanvasRemovals.map((item) => item.canvasId),
    ...nai.pendingCanvasRemovals.map((item) => item.canvasId),
    ...deletionEvents.map((event) => event.canvasId),
  ])
  const hiddenImages = new Set([
    ...removedImages,
    ...drawing.pendingAssetRemovals.map((item) => item.assetId),
    ...nai.pendingAssetRemovals.map((item) => item.assetId),
    ...deletionEvents
      .filter((event) => event.assetId)
      .map((event) => event.assetId as string),
  ])
  const matches = (kind: string, title: string) =>
    (source === 'all' || source === kind) &&
    title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const projectNames = new Map(
    localProjects.map((project) => [project.id, project.name])
  )
  const imageItems = mergeGalleryImages(
    images.data ?? [],
    (local.data ?? []).flatMap(({ canvas, assets }) =>
      localGalleryImages(canvas, assets)
    )
  )
    .filter(
      (image) =>
        !hiddenImages.has(image.id) &&
        !hiddenProjects.has(image.canvas_id ?? '') &&
        matches(
          image.source,
          `${image.prompt} ${
            image.canvas_name ?? projectNames.get(image.canvas_id ?? '') ?? ''
          }`
        )
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.prompt.localeCompare(b.prompt) || a.id.localeCompare(b.id)
        : (sort === 'oldest'
            ? a.created_at - b.created_at
            : b.created_at - a.created_at) || a.id.localeCompare(b.id)
    )
  const mergedProjects = new Map<string, CanvasProjectView>(
    (canvases.data ?? []).map((canvas) => [
      canvas.id,
      {
        id: canvas.id,
        kind: canvas.kind,
        name: canvas.name,
        revision: canvas.revision,
        state: canvas.state,
        updatedAt: canvas.updated_at,
        expiresAt: canvas.expires_at,
        coverAssetIds: canvas.cover_asset_ids,
      },
    ])
  )
  for (const canvas of localProjects) {
    const assets =
      local.data?.find((item) => item.canvas.id === canvas.id)?.assets ?? []
    const remote = mergedProjects.get(canvas.id)
    mergedProjects.set(canvas.id, {
      id: canvas.id,
      kind: canvas.kind,
      name: canvas.name,
      revision: canvas.revision,
      state: 'ready',
      updatedAt: Math.max(
        remote?.updatedAt ?? 0,
        Math.floor(canvas.localSavedAt / 1000)
      ),
      expiresAt: canvas.expiresAt,
      coverAssetIds: assets
        .filter(
          (asset) =>
            asset.role !== 'mask' && !canvas.removedAssetIds.includes(asset.id)
        )
        .map((asset) => asset.id)
        .slice(0, 4),
      coverBlobs: Object.fromEntries(
        assets.map((asset) => [asset.id, asset.blob])
      ),
      localOnly: !canvas.cloudRevision || canvas.needsExplicitSave,
      status: canvas.status,
    })
  }
  const projects = [...mergedProjects.values()]
    .filter(
      (project) =>
        project.state === 'ready' &&
        !hiddenProjects.has(project.id) &&
        matches(project.kind, project.name)
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        : (sort === 'oldest'
            ? a.updatedAt - b.updatedAt
            : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)
    )
  const activeQuery = view === 'images' ? images : canvases
  const imageBadgeCount = images.data ? imageItems.length : null
  const localOnlyCanvasCount = localProjects.filter(
    (canvas) => !canvas.cloudRevision || canvas.needsExplicitSave
  ).length
  let canvasBadgeCount: number | null = null
  if (canvases.data) canvasBadgeCount = projects.length
  else if (canvasCount.data) {
    canvasBadgeCount = canvasCount.data.total + localOnlyCanvasCount
  }
  const total = view === 'images' ? imageItems.length : projects.length
  const pages = Math.max(1, Math.ceil(total / metrics.pageSize))
  const currentPage = Math.min(page, pages)
  const offset = (currentPage - 1) * metrics.pageSize
  const status = drawing.statusText || nai.statusText
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }
  const refresh = async () => {
    await Promise.all([
      usage.refetch(),
      activeQuery.refetch(),
      local.refetch(),
      canvasCount.refetch(),
    ])
  }
  const invalidate = async () => {
    await Promise.all(
      ['images', 'canvases', 'usage', 'canvas-count'].map((part) =>
        client.invalidateQueries({ queryKey: [...key, part] })
      )
    )
  }
  const projectFor = (kind: CanvasKind) => (kind === 'drawing' ? drawing : nai)
  const navigateToCanvas = async (
    id: string,
    kind: CanvasKind,
    image?: string
  ) => {
    await navigate({
      to: kind === 'drawing' ? '/canvas/drawing' : '/canvas/nai',
      search: { canvas: id, image },
    })
  }
  const openProjectNow = async (
    id: string,
    kind: CanvasKind,
    image?: string
  ) => {
    await projectFor(kind).open(id, image)
    await navigateToCanvas(id, kind, image)
  }
  const createProjectNow = async (name: string, kind: CanvasKind) => {
    const canvas = await projectFor(kind).create(name)
    setDialog(null)
    await navigateToCanvas(canvas.id, kind)
  }
  const openProject = (id: string, kind: CanvasKind, image?: string) => {
    const sourceKind = getUnsavedCanvasKind(identity)
    if (sourceKind) {
      setError(null)
      setPendingCanvasAction({ type: 'open', id, kind, image, sourceKind })
      return
    }
    void run(async () => {
      await openProjectNow(id, kind, image)
    })
  }
  const submitDialog = (name: string, kind: CanvasKind) => {
    const sourceKind = getUnsavedCanvasKind(identity)
    if (dialog === 'create' && sourceKind) {
      setDialog(null)
      setError(null)
      setPendingCanvasAction({ type: 'create', name, kind, sourceKind })
      return
    }
    void run(async () => {
      if (dialog === 'create') {
        await createProjectNow(name, kind)
      } else if (renameTarget) {
        await (renameTarget.kind === 'drawing' ? drawing : nai).rename(
          renameTarget.id,
          name
        )
        setDialog(null)
        setRenameTarget(null)
      }
      await invalidate()
    })
  }
  const resolveCanvasAction = (decision: 'save' | 'discard') => {
    if (!pendingCanvasAction) return
    const action = pendingCanvasAction
    const project = projectFor(action.sourceKind)
    void (async () => {
      setBusy(true)
      setError(null)
      try {
        if (decision === 'save') await project.save()
        else await project.discard()
        if (action.type === 'open') {
          await openProjectNow(action.id, action.kind, action.image)
        } else {
          await createProjectNow(action.name, action.kind)
        }
        setPendingCanvasAction(null)
        await invalidate()
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Request failed')
      } finally {
        setBusy(false)
      }
    })()
  }
  const confirmDelete = () => {
    if (!deleteTarget) return
    const target = deleteTarget
    const userId = props.identity.userId
    void run(async () => {
      await (target.kind === 'drawing' ? drawing : nai).deleteProject(target.id)
      if (userId !== null) {
        await Promise.all(
          imageItems
            .filter((image) => image.canvas_id === target.id)
            .map((image) =>
              removeGalleryThumbnail(userId, image.id).catch(() => undefined)
            )
        )
      }
      setRemovedProjects((ids) => [...ids, target.id])
      setDeleteTarget(null)
      await Promise.all(
        ['images', 'canvases'].map((part) =>
          client.cancelQueries({ queryKey: [...key, part] })
        )
      )
      client.setQueryData<GalleryImage[]>([...key, 'images'], (current) =>
        current?.filter((image) => image.canvas_id !== target.id)
      )
      client.setQueryData<CanvasSummary[]>([...key, 'canvases'], (current) =>
        current?.filter((canvas) => canvas.id !== target.id)
      )
      await invalidate()
    })
  }
  const confirmImageDelete = () => {
    if (!imageDeleteTarget) return
    const image = imageDeleteTarget
    const userId = props.identity.userId
    void run(async () => {
      if (image.canvas_id) {
        await (image.source === 'drawing' ? drawing : nai).deleteResource(
          image.canvas_id,
          image.id
        )
      } else {
        await deleteGalleryImage(props.identity, image.id)
        await checkCanvasCapacity(props.identity, true)
      }
      if (userId !== null) {
        await removeGalleryThumbnail(userId, image.id).catch(() => undefined)
      }
      setRemovedImages((ids) => [...ids, image.id])
      setImageDeleteTarget(null)
      setPreview(null)
      await invalidate()
    })
  }
  const loading =
    (activeQuery.isPending && !total) ||
    drawing.loading ||
    nai.loading ||
    local.isPending
  return (
    <main
      id='content'
      className='flex h-full min-h-0 flex-col gap-3 p-4 sm:px-6 sm:pb-6'
    >
      {error ? (
        <Alert variant='destructive'>
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      ) : null}
      {activeQuery.isError ||
      usage.isError ||
      local.isError ||
      canvasCount.isError ? (
        <ErrorState
          description={t('Gallery could not be loaded.')}
          onRetry={() => void run(refresh)}
        />
      ) : null}
      <Tabs
        className='flex min-h-0 flex-1 flex-col gap-3'
        value={view}
        onValueChange={(value) => {
          setView(value)
          setPage(1)
        }}
      >
        <div className='flex shrink-0 flex-wrap items-center gap-3'>
          <TabsList className='group-data-horizontal/tabs:h-11'>
            <TabsTrigger value='images' className='gap-2 px-5 text-base'>
              {t('Images')}
              <Badge variant='secondary'>{imageBadgeCount ?? '…'}</Badge>
            </TabsTrigger>
            <TabsTrigger value='canvases' className='gap-2 px-5 text-base'>
              {t('Canvases')}
              <Badge variant='secondary'>{canvasBadgeCount ?? '…'}</Badge>
            </TabsTrigger>
          </TabsList>
          {usage.data ? <GalleryUsageMeters usage={usage.data} /> : null}
          {status ? (
            <CanvasSaveStatus
              localStatus='saved'
              cloudStatus='full'
              statusText={status}
            />
          ) : null}
          <div className='ms-auto flex min-w-0 flex-wrap items-center gap-2'>
            <Input
              className='w-full sm:w-56'
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(1)
              }}
              placeholder={t('Search')}
              aria-label={t('Search')}
            />
            <Select
              value={source}
              onValueChange={(value) => {
                setSource(value ?? 'all')
                setPage(1)
              }}
            >
              <SelectTrigger aria-label={t('Source')}>
                <SelectValue>
                  {
                    {
                      all: t('All'),
                      drawing: t('Drawing'),
                      nai: t('NAI Canvas'),
                      api: t('API'),
                    }[source]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value='all'>{t('All')}</SelectItem>
                  <SelectItem value='drawing'>{t('Drawing')}</SelectItem>
                  <SelectItem value='nai'>{t('NAI Canvas')}</SelectItem>
                  <SelectItem value='api'>{t('API')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(value) => {
                setSort(value ?? 'newest')
                setPage(1)
              }}
            >
              <SelectTrigger aria-label={t('Sort')}>
                <SelectValue>
                  {
                    {
                      newest: t('Newest'),
                      oldest: t('Oldest'),
                      name: t('Name'),
                    }[sort]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value='newest'>{t('Newest')}</SelectItem>
                  <SelectItem value='oldest'>{t('Oldest')}</SelectItem>
                  <SelectItem value='name'>{t('Name')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant='outline'
              onClick={() => void run(refresh)}
              disabled={busy}
            >
              {t('Refresh')}
            </Button>
            <Button
              onClick={() => {
                setRenameTarget(null)
                setDialog('create')
              }}
              disabled={busy}
            >
              {t('New canvas')}
            </Button>
          </div>
        </div>
        <div ref={gridRef} className='min-h-0 flex-1 overflow-hidden'>
          <TabsContent value='images' className='h-full'>
            {loading && <LoadingState />}
            {!loading && imageItems.length > 0 && (
              <div
                className={
                  metrics.measured
                    ? 'grid gap-4'
                    : 'grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]'
                }
                style={
                  metrics.measured
                    ? {
                        gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`,
                        gridAutoRows: `${metrics.rowHeight}px`,
                      }
                    : undefined
                }
              >
                {imageItems
                  .slice(offset, offset + metrics.pageSize)
                  .map((image) => (
                    <GalleryImageCard
                      key={image.id}
                      image={image}
                      identity={props.identity}
                      onPreview={() => setPreview(image)}
                      onDelete={() => setImageDeleteTarget(image)}
                      onOpenCanvas={
                        image.canvas_id
                          ? () => {
                              if (image.canvas_id) {
                                openProject(
                                  image.canvas_id,
                                  image.source === 'nai' ? 'nai' : 'drawing',
                                  image.id
                                )
                              }
                            }
                          : undefined
                      }
                    />
                  ))}
              </div>
            )}
            {!loading && !imageItems.length && !activeQuery.isError && (
              <EmptyState
                title={t('No saved images')}
                description={t(
                  'New final canvas images will appear here automatically.'
                )}
              />
            )}
          </TabsContent>
          <TabsContent value='canvases' className='h-full'>
            {loading && <LoadingState />}
            {!loading && projects.length > 0 && (
              <div
                className={
                  metrics.measured
                    ? 'grid gap-4'
                    : 'grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]'
                }
                style={
                  metrics.measured
                    ? {
                        gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`,
                        gridAutoRows: `${metrics.rowHeight}px`,
                      }
                    : undefined
                }
              >
                {projects
                  .slice(offset, offset + metrics.pageSize)
                  .map((project) => (
                    <CanvasCard
                      key={project.id}
                      identity={props.identity}
                      project={project}
                      onOpen={() => openProject(project.id, project.kind)}
                      onRename={() => {
                        setRenameTarget(project)
                        setDialog('rename')
                      }}
                      onDelete={() => setDeleteTarget(project)}
                    />
                  ))}
              </div>
            )}
            {!loading && !projects.length && !activeQuery.isError && (
              <EmptyState
                title={t('No canvases')}
                description={t('Create a canvas to start saving your work.')}
              />
            )}
          </TabsContent>
        </div>
      </Tabs>
      <Pagination className='shrink-0' aria-label={t('Pagination')}>
        <PaginationContent>
          <PaginationItem>
            <Button
              variant='outline'
              aria-label={t('Go to previous page')}
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              {t('Previous')}
            </Button>
          </PaginationItem>
          <PaginationItem>
            <span className='px-3 text-sm'>
              {currentPage} / {pages}
            </span>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant='outline'
              aria-label={t('Go to next page')}
              disabled={currentPage >= pages}
              onClick={() => setPage(currentPage + 1)}
            >
              {t('Next')}
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
      {preview ? (
        <GalleryPreview
          key={preview.id}
          image={preview}
          identity={props.identity}
          onClose={() => setPreview(null)}
        />
      ) : null}
      <CanvasProjectDialog
        open={dialog !== null}
        mode={dialog ?? 'create'}
        initialName={renameTarget?.name}
        initialKind={renameTarget?.kind}
        busy={busy}
        error={error}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null)
            setRenameTarget(null)
          }
        }}
        onSubmit={submitDialog}
      />
      <CanvasSwitchDialog
        open={pendingCanvasAction !== null}
        busy={busy}
        error={error}
        onOpenChange={(open) => {
          if (!open) {
            setPendingCanvasAction(null)
            setError(null)
          }
        }}
        onDiscard={() => resolveCanvasAction('discard')}
        onSave={() => resolveCanvasAction('save')}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('Delete canvas')}
        desc={t('The canvas and its images will be deleted.')}
        destructive
        isLoading={busy}
        confirmText={t('Delete')}
        handleConfirm={confirmDelete}
      >
        {error ? <p role='alert'>{t(error)}</p> : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={imageDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setImageDeleteTarget(null)
        }}
        title={t('Delete image')}
        desc={t('This image will be removed from the gallery and its canvas.')}
        destructive
        isLoading={busy}
        confirmText={t('Delete')}
        handleConfirm={confirmImageDelete}
      >
        {error ? <p role='alert'>{t(error)}</p> : null}
      </ConfirmDialog>
    </main>
  )
}
